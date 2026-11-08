export type PromptMenuAlignment = "start" | "end";

const EDGE_PADDING = 8;
const MENU_GAP = 8;

export function positionPromptMenu(
  anchor: HTMLElement | null,
  menu: HTMLElement | null,
  alignment: PromptMenuAlignment = "start",
  preservePlacement = false
) {
  if (!anchor || !menu || !anchor.isConnected || !menu.isConnected) return;

  const previousScrollTop = menu.scrollTop;
  const existingPlacement = preservePlacement ? menu.dataset.placement : undefined;
  const anchorRect = anchor.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;

  menu.style.position = "fixed";
  menu.style.top = "0px";
  menu.style.right = "auto";
  menu.style.bottom = "auto";
  menu.style.left = "0px";
  menu.style.maxWidth = `${Math.max(0, viewportWidth - EDGE_PADDING * 2)}px`;
  menu.style.maxHeight = "none";
  menu.style.visibility = "hidden";

  const menuRect = menu.getBoundingClientRect();
  const naturalHeight = menu.scrollHeight;
  const aboveSpace = Math.max(0, anchorRect.top - EDGE_PADDING - MENU_GAP);
  const belowSpace = Math.max(0, viewportHeight - anchorRect.bottom - EDGE_PADDING - MENU_GAP);
  const placement = existingPlacement === "above" || existingPlacement === "below"
    ? existingPlacement
    : naturalHeight <= aboveSpace || aboveSpace > belowSpace
      ? "above"
      : "below";
  const availableSpace = placement === "above" ? aboveSpace : belowSpace;
  const maxHeight = Math.max(0, Math.floor(availableSpace));
  const renderedHeight = Math.min(naturalHeight, maxHeight);
  const left = alignment === "end" ? anchorRect.right - menuRect.width : anchorRect.left;
  const boundedLeft = Math.min(
    Math.max(EDGE_PADDING, left),
    Math.max(EDGE_PADDING, viewportWidth - menuRect.width - EDGE_PADDING)
  );
  const top = placement === "above"
    ? anchorRect.top - MENU_GAP - renderedHeight
    : anchorRect.bottom + MENU_GAP;

  menu.style.left = `${boundedLeft}px`;
  menu.style.top = `${Math.max(EDGE_PADDING, Math.min(top, viewportHeight - EDGE_PADDING - renderedHeight))}px`;
  menu.style.maxHeight = `${maxHeight}px`;
  menu.style.overflowY = "auto";
  menu.style.scrollbarWidth = "thin";
  menu.style.zIndex = "10001";
  menu.style.visibility = "";
  menu.dataset.placement = placement;
  menu.dataset.positioned = "true";
  menu.scrollTop = previousScrollTop;
}
