import { redirect } from "next/navigation";

// The dedicated History page was removed — saved conversations now live in
// the sidebar Chats section. Bookmarks to /history land on the chat home.
export default function HistoryRedirect() {
  redirect("/");
}