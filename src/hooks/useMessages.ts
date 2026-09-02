"use client";

import { useState, useCallback, useRef } from "react";
import { AttachedFile } from "./useFileProcessor";

export interface Message {
  role: "user" | "assistant";
  content: string;
  time: string;
  files?: AttachedFile[];
  images?: { name: string; dataUrl: string; size: number }[];
}

export function useMessages() {
  const [messages, setMessages] = useState<Message[]>([]);

  // Use ref to always have latest messages in callbacks
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const addMessage = useCallback((msg: Message) => {
    setMessages(prev => [...prev, msg]);
  }, []);

  const updateLastMessage = useCallback((content: string) => {
    setMessages(prev => {
      const updated = [...prev];
      updated[updated.length - 1] = { ...updated[updated.length - 1], content };
      return updated;
    });
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  const now = () => new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

  return {
    messages,
    setMessages,
    messagesRef,
    addMessage,
    updateLastMessage,
    clearMessages,
    now,
    isEmpty: messages.length === 0,
  };
}
