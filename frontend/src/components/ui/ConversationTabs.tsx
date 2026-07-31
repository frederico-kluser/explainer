"use client";

import { useState, useCallback } from "react";
import { Plus, X } from "lucide-react";
import {
	SmoothTabs,
	SmoothTabsList,
	SmoothTabsTab,
	SmoothTabsPanels,
	SmoothTabsPanel,
} from "@/components/motion-ui/smooth-tabs";

export interface ConversationTab {
	id: string;
	title: string;
}

export interface ConversationTabsProps {
	conversations: ConversationTab[];
	activeId: string;
	onSelect: (id: string) => void;
	onCreate: () => void;
	onDelete: (id: string) => void;
}

function truncate(text: string, maxLen = 30): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen - 1) + "…";
}

export function ConversationTabs({
	conversations,
	activeId,
	onSelect,
	onCreate,
	onDelete,
}: ConversationTabsProps) {
	const [pendingDelete, setPendingDelete] = useState<string | null>(null);

	const handleDelete = useCallback(
		(id: string) => {
			if (pendingDelete === id) {
				onDelete(id);
				setPendingDelete(null);
			} else {
				setPendingDelete(id);
				// Reset confirmation after 3 seconds
				setTimeout(() => setPendingDelete(null), 3000);
			}
		},
		[pendingDelete, onDelete],
	);

	return (
		<SmoothTabs
			value={activeId}
			onValueChange={onSelect}
			className="flex h-full flex-col"
		>
			<div className="flex items-center gap-2">
				<SmoothTabsList
					ariaLabel="Conversas"
					className="flex-1 overflow-x-auto"
				>
					{conversations.map((conv) => (
						<SmoothTabsTab
							key={conv.id}
							value={conv.id}
							className="group relative pr-8"
						>
							<span className="block max-w-[180px] truncate">
								{truncate(conv.title)}
							</span>
							<span
								role="button"
								tabIndex={0}
								onClick={(e) => {
									e.stopPropagation();
									handleDelete(conv.id);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										e.stopPropagation();
										handleDelete(conv.id);
									}
								}}
								className={`absolute right-1 top-1/2 -translate-y-1/2 inline-flex size-5 items-center justify-center rounded-sm transition-colors cursor-pointer ${
									pendingDelete === conv.id
										? "bg-destructive text-destructive-foreground"
										: "opacity-0 group-hover:opacity-100 hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground"
								}`}
								title={
									pendingDelete === conv.id
										? "Clique para confirmar"
										: "Deletar conversa"
								}
								aria-label={
									pendingDelete === conv.id
										? "Confirmar exclusão"
										: "Deletar conversa"
								}
							>
								<X className="size-3" />
							</span>
						</SmoothTabsTab>
					))}
				</SmoothTabsList>
				<button
					type="button"
					onClick={onCreate}
					className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					title="Nova conversa"
					aria-label="Nova conversa"
				>
					<Plus className="size-4" />
				</button>
			</div>
			<SmoothTabsPanels className="mt-4 flex-1">
				{conversations.map((conv) => (
					<SmoothTabsPanel key={conv.id} value={conv.id}>
						{/* Content rendered by parent via children or external state */}
					</SmoothTabsPanel>
				))}
			</SmoothTabsPanels>
		</SmoothTabs>
	);
}
