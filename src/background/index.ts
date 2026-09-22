chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    console.error("Could not enable the toolbar side panel. Reload the extension and check Chrome support.");
  });
});
