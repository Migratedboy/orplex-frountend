"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConversations, type Conversation } from "@/components/ConversationProvider";
import { announceConversationOpen } from "@/lib/navigation-events";
import { IconSearch, IconMessage, IconTrash, IconClose } from "@/components/Icons";

export default function HistoryPage() {
  const { conversations, loading, deleteConversation } = useConversations();
  const [search, setSearch] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const router = useRouter();

  const filtered = conversations.filter(c => c.title.toLowerCase().includes(search.toLowerCase()));

  const groupByDate = (convs: Conversation[]) => {
    const groups: Record<string, Conversation[]> = {};
    convs.forEach(c => {
      const d = new Date(c.updatedAt);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
      const key = d >= today ? "Today" : d >= yesterday ? "Yesterday" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    });
    return groups;
  };

  const deleteConv = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeletingId(id);
    await deleteConversation(id);
    setDeletingId(null);
  };

  const groups = groupByDate(filtered);

  return (
      <div className="page-content">
        <div className="page-container">
          <div className="page-header">
            <div className="page-header-text">
              <h2 className="page-title">Session History</h2>
              <p className="page-subtitle">Review past interactions and agent tasks.</p>
            </div>
            <div className="search-box">
              <IconSearch size={14} className="search-box-icon" />
              <input className="search-box-input" placeholder="Search sessions..." value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && (
                <button className="search-box-clear" onClick={() => setSearch("")}>
                  <IconClose size={12} />
                </button>
              )}
            </div>
          </div>

          {loading ? (
            <div className="skeleton-list">
              {[1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 72 }} />)}
            </div>
          ) : Object.keys(groups).length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon"><IconMessage size={40} /></div>
              <p className="empty-state-title">No conversations yet</p>
              <p className="empty-state-text">Start a chat to see your history here.</p>
            </div>
          ) : (
            <div className="history-groups">
              {Object.entries(groups).map(([group, items]) => (
                <div key={group} className="history-group">
                  <div className="history-group-label">
                    <span>{group}</span>
                    <span className="history-group-count">{items.length}</span>
                  </div>
                  <div className="history-card">
                    {items.map((item, i) => (
                      <div key={item.id} onClick={() => { router.push(`/?c=${item.id}`); announceConversationOpen(item.id); }}
                        className="history-item" style={{ borderBottom: i < items.length - 1 ? "1px solid var(--border-color, #E4E4E7)" : "none" }}>
                        <div className="history-item-icon">
                          <IconMessage size={16} />
                        </div>
                        <div className="history-item-body">
                          <div className="history-item-row">
                            <h4 className="history-item-title">{item.title}</h4>
                            <div className="history-item-meta">
                              <span className="history-item-time">
                                {new Date(item.updatedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                              </span>
                              <button
                                onClick={(e) => deleteConv(item.id, e)}
                                className="history-item-delete"
                                title="Delete conversation"
                                disabled={deletingId === item.id}
                              >
                                <IconTrash size={14} />
                              </button>
                            </div>
                          </div>
                          <p className="history-item-snippet">{item.messages?.[0]?.content?.slice(0, 120) || "No messages"}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
  );
}
