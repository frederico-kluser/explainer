import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "fs";
import os from "os";
import path from "path";

// Issued by `scripts/dev-cert.mjs`, which `dev.sh` runs before starting Vite.
// Absent whenever mkcert is not installed, so the dev server falls back to
// plain HTTP rather than refusing to start: the app still works on localhost,
// and only the phone loses its microphone.
const certFile = path.resolve(__dirname, "../.certs/lan.pem");
const keyFile = path.resolve(__dirname, "../.certs/lan-key.pem");
const https =
	fs.existsSync(certFile) && fs.existsSync(keyFile)
		? { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
		: undefined;

// `scripts/dev-cert.mjs` drops the local authority in public/, and Vite's
// static handler serves a .pem with no Content-Type at all — a phone then
// sniffs the PEM as text and renders the base64 instead of offering to install
// it. Declaring the type is what turns the URL into an install prompt.
// Registered from configureServer, which runs before Vite's own middlewares,
// so this one answers first, and `apply: "serve"` keeps it out of a build.
// The certificate itself is a local, gitignored artifact: a fresh checkout has
// no public/rootCA.pem until `npm run dev` writes one.
function serveLocalAuthority(): Plugin {
	return {
		name: "explainer-serve-root-ca",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use("/rootCA.pem", (_req, res, next) => {
				const file = path.resolve(__dirname, "public/rootCA.pem");
				if (!fs.existsSync(file)) return next();
				res.setHeader("Content-Type", "application/x-x509-ca-cert");
				res.end(fs.readFileSync(file));
			});
		},
	};
}

export default defineConfig({
	plugins: [tailwindcss(), react(), serveLocalAuthority()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		// Exposes 5173 on the LAN so a phone can reach it. The backend stays on
		// 127.0.0.1: the proxy below is resolved by this Node process on the
		// host, not by the phone, so port 3001 never has to leave loopback.
		host: true,
		port: 5173,
		https,
		// Vite already allows localhost, *.localhost and every IP address, so
		// reaching the server by IP needs nothing here. Only the mDNS name the
		// certificate also covers has to be added — same short label that
		// scripts/dev-cert.mjs puts in the certificate.
		//
		// Never `allowedHosts: true` — Vite's own docs flag it as a DNS
		// rebinding hole that lets any website read this server's source.
		allowedHosts: [`${os.hostname().split(".")[0]}.local`],
		proxy: {
			"/api": {
				target: "http://localhost:3001",
				changeOrigin: true,
				// Without this the backend cannot tell its owner from a guest.
				// This proxy is resolved by the Node process on the host, so
				// every request it forwards reaches 127.0.0.1:3001 *from*
				// 127.0.0.1 — the phone on the wifi and the person sitting at
				// the machine arrive as the same socket. `xfwd` adds
				// `X-Forwarded-For` carrying the address that opened the
				// connection to Vite, which is the only thing left that still
				// separates them. It appends rather than replaces, so a client
				// sending its own value cannot overwrite the truth —
				// `backend/src/middleware/access-key.ts` is the consumer, and
				// explains why that is what makes the header safe to believe
				// there and nowhere else.
				xfwd: true,
			},
		},
	},
});
