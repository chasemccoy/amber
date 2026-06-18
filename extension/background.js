// amber — archive this page (MV3 service worker)
//
// Grabs the active tab's already-rendered DOM and hands it to the local amber
// native-messaging host, which saves a self-contained offline copy. The tab is
// the capture environment (JS has run, the user's session applies), so there is
// no headless browser involved.

const HOST = "org.chsmc.amber";
const MENU_ID = "amber-archive-page";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Archive this page with amber",
    contexts: ["page", "action"],
  });
});

// Triggers: toolbar button, context menu, keyboard shortcut.
chrome.action.onClicked.addListener((tab) => archiveTab(tab));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) archiveTab(tab);
});
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "archive-page") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  archiveTab(tab);
});

async function archiveTab(tab) {
  if (!tab || !tab.id || !/^https?:/.test(tab.url || "")) {
    return badge(tab?.id, "✗", "#b91c1c", "amber can only archive http(s) pages");
  }

  badge(tab.id, "…", "#f59e0b", "Archiving…");

  let payload;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ url: location.href, html: document.documentElement.outerHTML }),
    });
    payload = result;
  } catch (err) {
    return fail(tab.id, `couldn't read the page: ${err?.message ?? err}`);
  }

  chrome.runtime.sendNativeMessage(HOST, payload, (response) => {
    if (chrome.runtime.lastError) {
      return fail(tab.id, `native host error: ${chrome.runtime.lastError.message}`);
    }
    if (!response || !response.ok) {
      return fail(tab.id, response?.error || "archive failed");
    }
    badge(tab.id, "✓", "#15803d", `Saved → ${response.outDir}`);
    notify(
      `Archived: ${response.title || payload.url}`,
      `${response.assetCount} assets · ${response.removed} junk removed` +
        (response.media ? ` · ${response.media} media` : "") +
        (response.assetErrors ? ` · ${response.assetErrors} asset errors` : "") +
        `\n${response.indexPath}`,
    );
  });
}

function fail(tabId, message) {
  badge(tabId, "✗", "#b91c1c", message);
  notify("amber: archive failed", message);
}

function badge(tabId, text, color, title) {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  if (title) chrome.action.setTitle({ tabId, title });
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
  });
}
