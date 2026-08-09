#!/usr/bin/env node
// Issues the LAN development certificate that `dev.sh` needs, and prints the
// pairing URL plus a QR code for it.
//
// Why a certificate at all: `getUserMedia` — the microphone — is only handed
// out in a secure context. `localhost` counts as one, a LAN IP does not, so a
// phone opening `http://192.168.x.x:5173` gets a working page with a dead
// microphone and no error that explains it.
//
// Why every boot and not once: the LAN address comes from DHCP. A certificate
// issued for yesterday's IP is invalid today and fails with the same wall of
// warnings as no certificate at all, so coverage is re-checked at each start
// and the certificate is re-issued when the address moved.
//
// Missing mkcert is not an error here. `dev.sh` must still come up — the app
// keeps working on `localhost`; only the phone loses its microphone.

import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CERT_DIR = path.join(ROOT, ".certs");
const CERT_FILE = path.join(CERT_DIR, "lan.pem");
const KEY_FILE = path.join(CERT_DIR, "lan-key.pem");
const PUBLIC_DIR = path.join(ROOT, "frontend", "public");
const PUBLIC_CA = path.join(PUBLIC_DIR, "rootCA.pem");
const PORT = 5173;

const C = {
	dim: "[2m",
	bold: "[1m",
	cyan: "[36m",
	yellow: "[33m",
	off: "[0m",
};

// ---------------------------------------------------------------------------
// QR code — byte mode, error correction level M, versions 1 to 9.
//
// Hand-rolled because dev.sh's premise is that starting the app installs
// nothing: a QR encoder is a few tables and a Reed-Solomon loop, which is
// cheaper to carry than a dependency in the boot path. Nine versions hold 182
// bytes at level M — three orders of magnitude more than `https://<ip>:5173`
// needs — and anything longer falls back to printing the URL alone.
// ---------------------------------------------------------------------------

// version → [ec codewords per block, [[block count, data codewords per block]]]
const QR_BLOCKS_M = {
	1: [10, [[1, 16]]],
	2: [16, [[1, 28]]],
	3: [26, [[1, 44]]],
	4: [18, [[2, 32]]],
	5: [24, [[2, 43]]],
	6: [16, [[4, 27]]],
	7: [18, [[4, 31]]],
	8: [22, [[2, 38], [2, 39]]],
	9: [22, [[3, 36], [2, 37]]],
};

const QR_ALIGNMENT = {
	1: [],
	2: [6, 18],
	3: [6, 22],
	4: [6, 26],
	5: [6, 30],
	6: [6, 34],
	7: [6, 22, 38],
	8: [6, 24, 42],
	9: [6, 26, 46],
};

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
	GF_EXP[i] = x;
	GF_LOG[x] = i;
	x <<= 1;
	if (x & 0x100) x ^= 0x11d; // the QR primitive polynomial
}
for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

function rsGenerator(degree) {
	let poly = [1];
	for (let i = 0; i < degree; i++) {
		const next = new Array(poly.length + 1).fill(0);
		for (let j = 0; j < poly.length; j++) {
			next[j] ^= poly[j];
			next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
		}
		poly = next;
	}
	return poly;
}

function rsRemainder(data, ecLength) {
	const gen = rsGenerator(ecLength);
	const buf = new Uint8Array(data.length + ecLength);
	buf.set(data);
	for (let i = 0; i < data.length; i++) {
		const factor = buf[i];
		if (factor === 0) continue;
		for (let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], factor);
	}
	return buf.slice(data.length);
}

function qrCodewords(bytes, version) {
	const [ecLength, groups] = QR_BLOCKS_M[version];
	const dataCapacity = groups.reduce((n, [count, size]) => n + count * size, 0);

	const bits = [];
	const push = (value, width) => {
		for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
	};
	push(0b0100, 4); // byte mode
	push(bytes.length, 8); // 8-bit character count indicator, versions 1..9
	for (const byte of bytes) push(byte, 8);
	for (let i = 0; i < 4 && bits.length < dataCapacity * 8; i++) bits.push(0);
	while (bits.length % 8 !== 0) bits.push(0);

	const data = [];
	for (let i = 0; i < bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
		data.push(byte);
	}
	for (let i = 0; data.length < dataCapacity; i++) data.push(i % 2 === 0 ? 0xec : 0x11);

	const dataBlocks = [];
	const ecBlocks = [];
	let offset = 0;
	for (const [count, size] of groups) {
		for (let i = 0; i < count; i++) {
			const block = Uint8Array.from(data.slice(offset, offset + size));
			offset += size;
			dataBlocks.push(block);
			ecBlocks.push(rsRemainder(block, ecLength));
		}
	}

	// Interleaved, as the standard requires: column-major across the blocks.
	const out = [];
	const widest = Math.max(...dataBlocks.map((b) => b.length));
	for (let i = 0; i < widest; i++) {
		for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
	}
	for (let i = 0; i < ecLength; i++) {
		for (const block of ecBlocks) out.push(block[i]);
	}
	return out;
}

function qrSkeleton(version) {
	const size = version * 4 + 17;
	const modules = Array.from({ length: size }, () => new Uint8Array(size));
	const fixed = Array.from({ length: size }, () => new Uint8Array(size));

	const finder = (row, col) => {
		for (let r = -1; r <= 7; r++) {
			for (let c = -1; c <= 7; c++) {
				const y = row + r;
				const x = col + c;
				if (y < 0 || y >= size || x < 0 || x >= size) continue;
				const onRing = r === 0 || r === 6 || c === 0 || c === 6;
				const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
				const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
				modules[y][x] = inside && (onRing || inCore) ? 1 : 0;
				fixed[y][x] = 1;
			}
		}
	};
	finder(0, 0);
	finder(0, size - 7);
	finder(size - 7, 0);

	for (let i = 8; i < size - 8; i++) {
		const dark = i % 2 === 0 ? 1 : 0;
		modules[6][i] = dark;
		fixed[6][i] = 1;
		modules[i][6] = dark;
		fixed[i][6] = 1;
	}

	const centres = QR_ALIGNMENT[version];
	const last = centres[centres.length - 1];
	for (const row of centres) {
		for (const col of centres) {
			// Omitted where it would land on a finder pattern.
			if ((row === 6 && col === 6) || (row === 6 && col === last) || (row === last && col === 6)) continue;
			for (let dr = -2; dr <= 2; dr++) {
				for (let dc = -2; dc <= 2; dc++) {
					modules[row + dr][col + dc] = Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 0 : 1;
					fixed[row + dr][col + dc] = 1;
				}
			}
		}
	}

	// Format areas are reserved before placement so the zigzag skips them.
	for (let i = 0; i <= 8; i++) {
		fixed[8][i] = 1;
		fixed[i][8] = 1;
	}
	for (let i = 0; i < 8; i++) {
		fixed[8][size - 1 - i] = 1;
		fixed[size - 1 - i][8] = 1;
	}
	modules[size - 8][8] = 1; // the always-dark module

	if (version >= 7) {
		for (let i = 0; i < 18; i++) {
			fixed[size - 11 + (i % 3)][Math.floor(i / 3)] = 1;
			fixed[Math.floor(i / 3)][size - 11 + (i % 3)] = 1;
		}
	}

	return { size, modules, fixed };
}

function qrPlaceData(size, modules, fixed, codewords) {
	let bit = 0;
	const nextBit = () => {
		const index = bit++;
		const byte = codewords[index >> 3];
		// Past the last codeword are the version's remainder bits, all zero.
		return byte === undefined ? 0 : (byte >> (7 - (index & 7))) & 1;
	};
	let upward = true;
	for (let right = size - 1; right > 0; right -= 2) {
		if (right === 6) right = 5; // the vertical timing column is not a data column
		for (let i = 0; i < size; i++) {
			const row = upward ? size - 1 - i : i;
			for (const col of [right, right - 1]) {
				if (fixed[row][col]) continue;
				modules[row][col] = nextBit();
			}
		}
		upward = !upward;
	}
}

const QR_MASKS = [
	(r, c) => (r + c) % 2 === 0,
	(r) => r % 2 === 0,
	(_r, c) => c % 3 === 0,
	(r, c) => (r + c) % 3 === 0,
	(r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
	(r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
	(r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
	(r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const QR_FINDER_RUN_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const QR_FINDER_RUN_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

function qrPenalty(size, modules) {
	let score = 0;

	for (let i = 0; i < size; i++) {
		for (const read of [(j) => modules[i][j], (j) => modules[j][i]]) {
			let run = 1;
			for (let j = 1; j < size; j++) {
				if (read(j) === read(j - 1)) {
					run++;
				} else {
					if (run >= 5) score += run - 2;
					run = 1;
				}
			}
			if (run >= 5) score += run - 2;
		}
	}

	for (let r = 0; r < size - 1; r++) {
		for (let c = 0; c < size - 1; c++) {
			const v = modules[r][c];
			if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
		}
	}

	for (let i = 0; i < size; i++) {
		for (let j = 0; j + 11 <= size; j++) {
			let hA = true;
			let hB = true;
			let vA = true;
			let vB = true;
			for (let k = 0; k < 11; k++) {
				const h = modules[i][j + k];
				const v = modules[j + k][i];
				if (h !== QR_FINDER_RUN_A[k]) hA = false;
				if (h !== QR_FINDER_RUN_B[k]) hB = false;
				if (v !== QR_FINDER_RUN_A[k]) vA = false;
				if (v !== QR_FINDER_RUN_B[k]) vB = false;
			}
			score += (hA ? 40 : 0) + (hB ? 40 : 0) + (vA ? 40 : 0) + (vB ? 40 : 0);
		}
	}

	let dark = 0;
	for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += modules[r][c];
	score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;

	return score;
}

function qrFormatBits(mask) {
	const data = (0b00 << 3) | mask; // 0b00 is error correction level M
	let rem = data << 10;
	for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
	return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function qrPlaceFormat(size, modules, mask) {
	const format = qrFormatBits(mask);
	const bit = (i) => (format >> i) & 1;
	const primary = [
		[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
		[7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
	];
	primary.forEach(([r, c], i) => {
		modules[r][c] = bit(14 - i);
	});
	for (let i = 0; i < 7; i++) modules[size - 1 - i][8] = bit(14 - i);
	for (let i = 7; i < 15; i++) modules[8][size - 15 + i] = bit(14 - i);
	modules[size - 8][8] = 1;
}

function qrPlaceVersion(size, modules, version) {
	if (version < 7) return;
	let rem = version << 12;
	for (let i = 17; i >= 12; i--) if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12);
	const info = (version << 12) | rem;
	for (let i = 0; i < 18; i++) {
		const b = (info >> i) & 1;
		modules[size - 11 + (i % 3)][Math.floor(i / 3)] = b;
		modules[Math.floor(i / 3)][size - 11 + (i % 3)] = b;
	}
}

/** @returns {number[][]|null} the module matrix, or null when the text does not fit. */
export function qrMatrix(text) {
	const bytes = new TextEncoder().encode(text);
	let version = 0;
	for (let v = 1; v <= 9; v++) {
		const capacity = QR_BLOCKS_M[v][1].reduce((n, [count, size]) => n + count * size, 0);
		if (4 + 8 + bytes.length * 8 <= capacity * 8) {
			version = v;
			break;
		}
	}
	if (version === 0) return null;

	const codewords = qrCodewords(bytes, version);
	const { size, modules, fixed } = qrSkeleton(version);
	qrPlaceData(size, modules, fixed, codewords);
	qrPlaceVersion(size, modules, version);

	let best = null;
	for (let mask = 0; mask < 8; mask++) {
		const candidate = modules.map((row) => Uint8Array.from(row));
		for (let r = 0; r < size; r++) {
			for (let c = 0; c < size; c++) {
				if (!fixed[r][c] && QR_MASKS[mask](r, c)) candidate[r][c] ^= 1;
			}
		}
		qrPlaceFormat(size, candidate, mask);
		const score = qrPenalty(size, candidate);
		if (best === null || score < best.score) best = { score, candidate };
	}
	return best.candidate.map((row) => Array.from(row));
}

/**
 * Two module rows per text row, via half blocks. Colours are set explicitly
 * rather than inherited: a QR drawn in the terminal's own foreground scans on
 * a dark theme and inverts to unreadable on a light one.
 */
export function qrToText(text) {
	const matrix = qrMatrix(text);
	if (!matrix) return null;
	const quiet = 4;
	const size = matrix.length;
	const width = size + quiet * 2;
	const at = (r, c) =>
		r < quiet || c < quiet || r >= size + quiet || c >= size + quiet ? 0 : matrix[r - quiet][c - quiet];

	const lines = [];
	for (let r = 0; r < size + quiet * 2; r += 2) {
		let line = "";
		for (let c = 0; c < width; c++) {
			const top = at(r, c);
			const bottom = r + 1 < size + quiet * 2 ? at(r + 1, c) : 0;
			// A light module must read light, so light is the glyph and dark is
			// the black background showing through.
			line += top && bottom ? " " : top ? "▄" : bottom ? "▀" : "█";
		}
		lines.push(`[97;40m${line}[0m`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

// Bridges and tunnels get an IPv4 too, and none of them is the address a phone
// on the wifi can reach. Naming them in the certificate would also make it
// expire and re-issue every time Docker or a VPN restarts.
const VIRTUAL_INTERFACE = /^(docker|br-|virbr|veth|tun|tap|vboxnet|vmnet|wg|zt|tailscale|utun|lo)/i;

// The mDNS name the certificate also covers. Only the short label: a machine
// whose hostname is already an FQDN would otherwise be named "host.lan.local".
// vite.config.ts derives the same name for `server.allowedHosts`.
export function mdnsName(hostname = os.hostname()) {
	return `${hostname.split(".")[0]}.local`;
}

export function lanAddresses(interfaces = os.networkInterfaces()) {
	const found = [];
	for (const [name, entries] of Object.entries(interfaces)) {
		if (!entries || VIRTUAL_INTERFACE.test(name)) continue;
		for (const entry of entries) {
			if (entry.family !== "IPv4" || entry.internal) continue;
			// Wireless first: the phone is on the wifi, and a machine plugged
			// into both would otherwise advertise the wired address.
			found.push({ name, address: entry.address, rank: /^wl/i.test(name) ? 0 : 1 });
		}
	}
	found.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
	return found.map((entry) => entry.address);
}

// Node prints IPv6 subject alternative names fully expanded — "::1" comes back
// as "0:0:0:0:0:0:0:1" — so both sides are expanded before being compared.
function expandIpv6(value) {
	const [head, tail = ""] = value.split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const groups = value.includes("::")
		? [...left, ...new Array(8 - left.length - right.length).fill("0"), ...right]
		: left;
	return groups.map((group) => String(parseInt(group || "0", 16))).join(":");
}

function canonicalName(value) {
	const trimmed = value.trim();
	return net.isIP(trimmed) === 6 ? expandIpv6(trimmed) : trimmed.toLowerCase();
}

export function certCovers(pem, names, now = Date.now()) {
	let cert;
	try {
		cert = new X509Certificate(pem);
	} catch {
		return false;
	}
	// A certificate about to lapse is re-issued now rather than mid-session.
	if (Date.parse(cert.validTo) - now < 24 * 60 * 60 * 1000) return false;
	const present = new Set(
		(cert.subjectAltName ?? "")
			.split(",")
			// Each entry is "DNS:name" or "IP Address:addr"; an IPv6 value keeps
			// its own colons, so only the first one separates type from value.
			.map((entry) => canonicalName(entry.slice(entry.indexOf(":") + 1))),
	);
	return names.every((name) => present.has(canonicalName(name)));
}

// ---------------------------------------------------------------------------
// mkcert
// ---------------------------------------------------------------------------

function mkcert(args) {
	return spawnSync("mkcert", args, { encoding: "utf8" });
}

function installHint(stale) {
	const platform = process.platform;
	// Two different situations, and saying "seguindo em HTTP" in the second one
	// would be a lie: the certificate on disk still starts the server in HTTPS,
	// it just no longer matches the address the phone will dial.
	const lines = stale
		? [
				`${C.yellow}[cert] o certificado de LAN não cobre mais este endereço, e o mkcert não${C.off}`,
				`${C.yellow}       está instalado para reemitir.${C.off}`,
				`${C.dim}       O Vite sobe em HTTPS com o certificado antigo e o celular vai recusar`,
				`       a conexão. Em localhost o app continua normal.${C.off}`,
				"",
				"  Para reemitir, instale o mkcert e rode `npm run dev` de novo:",
			]
		: [
				`${C.yellow}[cert] mkcert não está instalado — seguindo em HTTP.${C.off}`,
				`${C.dim}       O app continua funcionando em http://localhost:${PORT}. Só o celular`,
				"       fica sem microfone: o navegador só libera o microfone em HTTPS ou em",
				`       localhost.${C.off}`,
				"",
				"  Para liberar o acesso pelo celular, instale o mkcert e rode `npm run dev` de novo:",
			];
	if (platform === "darwin") {
		lines.push("    brew install mkcert nss", "    mkcert -install");
	} else if (platform === "win32") {
		lines.push("    choco install mkcert", "    mkcert -install");
	} else {
		lines.push(
			"    sudo apt install mkcert libnss3-tools     # Debian/Ubuntu/Pop!_OS",
			"    sudo pacman -S mkcert nss                 # Arch",
			"    mkcert -install",
		);
	}
	lines.push("", `${C.dim}  Detalhes: README.md → “Usar do celular pela rede”.${C.off}`);
	return lines.join("\n");
}

function copyRootCa(caRoot) {
	const source = path.join(caRoot, "rootCA.pem");
	if (!fs.existsSync(source)) return false;
	const content = fs.readFileSync(source);
	// Only written when it actually changed: frontend/public is watched, and
	// rewriting the file every boot would make Vite reload the page for nothing.
	if (fs.existsSync(PUBLIC_CA) && fs.readFileSync(PUBLIC_CA).equals(content)) return true;
	fs.mkdirSync(PUBLIC_DIR, { recursive: true });
	fs.writeFileSync(PUBLIC_CA, content);
	return true;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Whether Vite will find a key pair to start TLS with — the same condition
// vite.config.ts tests, so the URL printed here is the URL that will answer.
function certFilesPresent() {
	return fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
}

function pairingUrl() {
	const [lan] = lanAddresses();
	const host = lan ?? "localhost";
	return `${certFilesPresent() ? "https" : "http"}://${host}:${PORT}`;
}

function main() {
	const printUrlOnly = process.argv.includes("--print-url");
	const addresses = lanAddresses();
	const names = ["localhost", "127.0.0.1", "::1", mdnsName(), ...addresses];

	if (printUrlOnly) {
		process.stdout.write(`${pairingUrl()}\n`);
		return;
	}

	const already = certFilesPresent() && certCovers(fs.readFileSync(CERT_FILE), names);

	const caRoot = mkcert(["-CAROOT"]);
	const haveMkcert = !caRoot.error && caRoot.status === 0;

	if (!haveMkcert && !already) {
		console.log(installHint(certFilesPresent()));
		return;
	}

	if (!already) {
		const caRootDir = caRoot.stdout.trim();
		if (!fs.existsSync(path.join(caRootDir, "rootCA.pem"))) {
			console.log(
				`${C.yellow}[cert] a autoridade local do mkcert ainda não foi instalada neste sistema.${C.off}\n` +
					`${C.dim}       Rode \`mkcert -install\` uma vez (ele pede a senha de administrador),\n` +
					`       senão o próprio navegador desta máquina vai desconfiar do certificado.${C.off}`,
			);
		}
		fs.mkdirSync(CERT_DIR, { recursive: true });
		const issued = mkcert(["-cert-file", CERT_FILE, "-key-file", KEY_FILE, ...names]);
		if (issued.status !== 0) {
			console.log(
				`${C.yellow}[cert] mkcert falhou — seguindo em HTTP.${C.off}\n` +
					`${C.dim}${(issued.stderr || issued.stdout || "").trim()}${C.off}`,
			);
			return;
		}
		console.log(`${C.dim}[cert] certificado emitido para ${names.join(", ")}${C.off}`);
	}

	if (haveMkcert && !copyRootCa(caRoot.stdout.trim())) {
		console.log(`${C.yellow}[cert] rootCA.pem não encontrado em ${caRoot.stdout.trim()} — rode \`mkcert -install\`.${C.off}`);
	}

	const url = pairingUrl();
	const qr = qrToText(url);
	console.log("");
	if (qr) console.log(qr);
	console.log(`${C.bold}  No celular, abra:  ${C.cyan}${url}${C.off}`);
	if (addresses.length === 0) {
		console.log(`${C.dim}  Nenhum endereço de rede encontrado — a máquina parece estar sem LAN.${C.off}`);
	}
	console.log(
		`${C.dim}  Da primeira vez o celular vai recusar o certificado. Instale a autoridade\n` +
			`  local uma única vez em ${url}/rootCA.pem — o passo a passo por sistema está\n` +
			`  no README.md, em “Usar do celular pela rede”. No iPhone são DOIS passos:\n` +
			`  instalar o perfil E ligar a confiança em Ajustes › Geral › Sobre.${C.off}`,
	);
	console.log("");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main();
}
