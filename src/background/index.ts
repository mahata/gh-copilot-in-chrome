// Chrome withholds the activeTab grant when a toolbar click toggles the side panel through
// openPanelOnActionClick, so the panel is opened from onClicked instead. Installs from
// earlier versions still have the behavior saved and need it switched off.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {
    console.error("Could not reset the side panel behavior. Reload the extension and check Chrome support.");
  });
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {
    console.error("Could not open the side panel. Reload the extension and check Chrome support.");
  });
});
