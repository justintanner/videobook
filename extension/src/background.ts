import { queueVideocityDownload } from "./mcp.js";
import { isHttpUrl, selectDownloadUrl } from "./url-target.js";

const CONTEXT_MENU_ID = "videocity-download";

function notify(title: string, message: string): void {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "vc-logo.png",
    title,
    message,
  });
}

function installContextMenu(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Download full source to Videocity",
      contexts: ["link", "page"],
    });
  });
}

async function handleContextClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  const url = selectDownloadUrl({
    linkUrl: info.linkUrl,
    pageUrl: info.pageUrl,
    tabUrl: tab?.url,
  });

  if (!url || !isHttpUrl(url)) {
    notify("Videocity", "This URL cannot be downloaded.");
    return;
  }

  try {
    const result = await queueVideocityDownload(url);
    notify("Videocity download queued", `${result.assetId} (${result.jobId})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify("Videocity download failed", message);
  }
}

chrome.runtime.onInstalled.addListener(installContextMenu);
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  void handleContextClick(info, tab);
});
