let currentTabUrl = null;

document.addEventListener('DOMContentLoaded', async function() {
  await loadCurrentTabCookies();
  loadSettings();
  setupEventListeners();
  
  // Listen for stats updates from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STATS_UPDATED') {
      displayStats(message.stats);
    }
  });
});

// Detect if cookie is ephemeral (temporary/short-lived)
function isEphemeralCookie(cookie) {
  const ephemeralPatterns = ['ST-', 'CONSISTENCY', 'GPS', 'YSC'];
  const isShortLived = ephemeralPatterns.some(pattern => cookie.name.startsWith(pattern) || cookie.name === pattern);
  
  const hasNoExpiration = !cookie.expirationDate || cookie.expirationDate === 0;
  
  const isShortExpiration = cookie.expirationDate && 
    (cookie.expirationDate - Date.now() / 1000) < 3600;
  
  return isShortLived || hasNoExpiration || isShortExpiration;
}

async function loadCurrentTabCookies() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentSiteEl = document.getElementById('site-url');
    
    if (tab && tab.url) {
      currentTabUrl = tab.url;
      const url = new URL(tab.url);
      currentSiteEl.innerHTML = `
        <strong>${url.hostname}</strong>
        <div style="font-size: 10px; color: #999; margin-top: 2px;">${url.origin}</div>
      `;
      
      // Get ALL cookie data from background (includes active, blocked, and removed cookies)
      const response = await chrome.runtime.sendMessage({ type: 'GET_ALL_COOKIE_DATA' });
      
      const cookiesList = document.getElementById('cookies-list');
      
      await updateStats();
      
      if (!response.cookies || response.cookies.length === 0) {
        cookiesList.innerHTML = `
          <div class="empty-state">
            <div style="font-size: 32px;">🍪</div>
            <div style="font-weight: bold; margin-bottom: 8px;">No Cookies Found</div>
            <div style="font-size: 11px; color: #999;">
              This website doesn't have any cookies yet, or they are blocked by browser settings.
            </div>
          </div>
        `;
        return;
      }
      
      cookiesList.innerHTML = '';
      
      // Enhanced sorting logic
      response.cookies.sort((a, b) => {
        const aBlockedByPermission = a.permission && a.permission.blocked;
        const bBlockedByPermission = b.permission && b.permission.blocked;
        
        const aActive = a.status === 'active' && a.value !== '[BLOCKED/REMOVED]';
        const bActive = b.status === 'active' && b.value !== '[BLOCKED/REMOVED]';
        
        const aBlocked = aBlockedByPermission && !aActive;
        const bBlocked = bBlockedByPermission && !bActive;
        
        const aUnblockedNotSet = !aBlockedByPermission && !aActive && a.status !== 'removed';
        const bUnblockedNotSet = !bBlockedByPermission && !bActive && b.status !== 'removed';
        
        const aRemoved = a.status === 'removed' && !aBlockedByPermission;
        const bRemoved = b.status === 'removed' && !bBlockedByPermission;
        
        let aPriority = 0;
        let bPriority = 0;
        
        if (aActive) aPriority = 4;
        else if (aBlocked) aPriority = 3;
        else if (aUnblockedNotSet) aPriority = 2;
        else if (aRemoved) aPriority = 1;
        
        if (bActive) bPriority = 4;
        else if (bBlocked) bPriority = 3;
        else if (bUnblockedNotSet) bPriority = 2;
        else if (bRemoved) bPriority = 1;
        
        if (aPriority !== bPriority) {
          return bPriority - aPriority;
        }
        
        return b.riskScore - a.riskScore;
      });
      
      for (const cookie of response.cookies) {
        const cookieEl = await createCookieElement(cookie);
        cookiesList.appendChild(cookieEl);
      }
    } else {
      document.getElementById('site-url').textContent = 'Cannot access current tab';
      document.getElementById('cookies-list').innerHTML = `
        <div class="empty-state">
          <div>Please refresh the page and try again</div>
        </div>
      `;
    }
  } catch (error) {
    console.error('Error loading cookies:', error);
    document.getElementById('cookies-list').innerHTML = `
      <div class="empty-state">
        <div style="color: #dc3545;">Error loading cookies</div>
        <div style="font-size: 11px; color: #999; margin-top: 8px;">
          Try refreshing the page or check browser permissions
        </div>
      </div>
    `;
  }
}

async function createCookieElement(cookie) {
  const div = document.createElement('div');
  div.className = 'cookie-item';
  const checkboxId = cookie.name.replace(/[^a-zA-Z0-9]/g, '-') + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  
  const isBlockedByPermission = cookie.permission && cookie.permission.blocked;
  const isCookieActive = cookie.status === 'active' && cookie.value !== '[BLOCKED/REMOVED]';
  
  const isBlocked = isBlockedByPermission && !isCookieActive;
  const isUnblockedButNotSet = !isBlockedByPermission && !isCookieActive && cookie.status !== 'removed';
  const isRemoved = cookie.status === 'removed' && !isBlockedByPermission;
  
  const isEphemeral = isEphemeralCookie(cookie);
  const isSuspicious = cookie.riskScore >= 3;
  
  if (isBlocked) {
    div.style.opacity = '0.85';
    div.style.border = '2px solid #dc3545';
    div.style.background = '#fff5f5';
  } else if (isUnblockedButNotSet) {
    div.style.opacity = '0.75';
    div.style.border = '2px solid #ffc107';
    div.style.background = '#fffbf0';
  } else if (isRemoved) {
    div.style.opacity = '0.7';
    div.style.border = '1px dashed #6c757d';
    div.style.background = '#f8f9fa';
  } else if (isSuspicious && isCookieActive) {
    div.style.border = '2px solid #ff6b6b';
    div.style.background = '#fff8f8';
  }
  
  const dataTypesHTML = cookie.potentialData && cookie.potentialData.length > 0 
    ? cookie.potentialData.map(dt => dt.replace(/_/g, ' ')).join(', ')
    : '<em style="color: #999;">No specific data types detected</em>';

  let statusHTML = '';
  if (isBlocked) {
    const blockedReason = cookie.autoBlocked ? ' (Auto-blocked)' : '';
    const blockedTime = cookie.blockedAt ? ` at ${new Date(cookie.blockedAt).toLocaleString()}` : '';
    statusHTML = `<div style="background: #f8d7da; color: #721c24; padding: 8px 12px; border-radius: 4px; font-size: 11px; margin-top: 8px; font-weight: bold;">
      🚫 BLOCKED${blockedReason} - Cookie Removed from Browser
      ${blockedTime ? `<div style="font-size: 9px; margin-top: 4px; font-weight: normal;">${blockedTime}</div>` : ''}
    </div>`;
  } else if (isUnblockedButNotSet) {
    statusHTML = `<div style="background: #fff3cd; color: #856404; padding: 8px 12px; border-radius: 4px; font-size: 11px; margin-top: 8px; font-weight: bold;">
      ⏳ UNBLOCKED - Waiting for Website to Set Cookie
      <div style="font-size: 9px; margin-top: 4px; font-weight: normal;">Refresh the page to allow the website to restore this cookie</div>
    </div>`;
  } else if (isRemoved) {
    if (isEphemeral) {
      statusHTML = '<div style="background: #d1ecf1; color: #0c5460; padding: 6px 10px; border-radius: 4px; font-size: 11px; margin-top: 8px;">ℹ️ Temporary Cookie Expired (Normal Behavior)</div>';
    } else {
      statusHTML = '<div style="background: #e2e3e5; color: #383d41; padding: 6px 10px; border-radius: 4px; font-size: 11px; margin-top: 8px;">ℹ️ Cookie No Longer Active</div>';
    }
  } else if (cookie.permission) {
    const action = cookie.permission.action;
    if (action === 'allow') {
      statusHTML = '<div style="background: #d4edda; color: #155724; padding: 6px 10px; border-radius: 4px; font-size: 11px; margin-top: 8px;">✅ Currently Allowed</div>';
    } else if (action === 'custom') {
      statusHTML = `<div style="background: #d1ecf1; color: #0c5460; padding: 6px 10px; border-radius: 4px; font-size: 11px; margin-top: 8px;">⚙️ Custom (${cookie.permission.allowedDataTypes.length} types allowed)</div>`;
    }
  }

  let timeInfoHTML = '';
  if (cookie.firstSeen) {
    const firstSeen = new Date(cookie.firstSeen).toLocaleString();
    const lastSeen = cookie.lastSeen ? new Date(cookie.lastSeen).toLocaleString() : firstSeen;
    timeInfoHTML = `
      <div style="font-size: 10px; color: #999; margin-top: 6px; padding-top: 6px; border-top: 1px solid #e0e0e0;">
        <div>First seen: ${firstSeen}</div>
        ${lastSeen !== firstSeen ? `<div>Last seen: ${lastSeen}</div>` : ''}
      </div>
    `;
  }

  let statusText = '';
  let statusIcon = '';
  if (isBlocked) {
    statusText = '<span style="color: #dc3545; font-weight: bold;">BLOCKED</span>';
    statusIcon = '🚫';
  } else if (isUnblockedButNotSet) {
    statusText = '<span style="color: #ffc107; font-weight: bold;">UNBLOCKED (Not Set)</span>';
    statusIcon = '⏳';
  } else if (isRemoved) {
    statusText = '<span style="color: #6c757d;">Removed</span>';
    statusIcon = '⚠️';
  } else {
    statusText = '<span style="color: #28a745;">Active</span>';
    statusIcon = '';
  }

  let suspiciousBadge = '';
  if (isSuspicious && isCookieActive) {
    suspiciousBadge = `
      <span style="background: #ff6b6b; color: white; padding: 2px 8px; border-radius: 12px; font-size: 10px; margin-left: 8px; font-weight: bold; animation: pulse 2s infinite;" title="This cookie collects ${cookie.potentialData?.length || 0} types of personal data">
        ⚠️ SUSPICIOUS
      </span>
    `;
  } else if (isSuspicious && isRemoved) {
    suspiciousBadge = `
      <span style="background: #ff6b6b; color: white; padding: 2px 8px; border-radius: 12px; font-size: 10px; margin-left: 8px; opacity: 0.6;" title="This was a suspicious cookie">
        ⚠️ WAS SUSPICIOUS
      </span>
    `;
  }

  let ephemeralBadge = '';
  if (isEphemeral && isCookieActive) {
    ephemeralBadge = `
      <span style="background: #17a2b8; color: white; padding: 2px 8px; border-radius: 12px; font-size: 10px; margin-left: 8px; font-weight: bold;" title="This cookie expires quickly (session or short-lived)">
        ⏱️ TEMPORARY
      </span>
    `;
  } else if (isEphemeral && isRemoved) {
    ephemeralBadge = `
      <span style="background: #6c757d; color: white; padding: 2px 8px; border-radius: 12px; font-size: 10px; margin-left: 8px; opacity: 0.6;" title="This was a temporary cookie">
        ⏱️ WAS TEMPORARY
      </span>
    `;
  }

  // AI Explanation Section (NEW!)
  let aiExplanationHTML = '';
  if (cookie.aiExplanation) {
    aiExplanationHTML = `
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 10px 12px; border-radius: 6px; font-size: 11px; margin-top: 10px; line-height: 1.5; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
        <div style="display: flex; align-items: center; margin-bottom: 6px;">
          <span style="font-size: 16px; margin-right: 6px;">🤖</span>
          <strong style="font-size: 12px;">AI Explains:</strong>
        </div>
        <div style="font-size: 11px; opacity: 0.95;">
          ${cookie.aiExplanation}
        </div>
      </div>
    `;
  } else {
    // Show loading state
    aiExplanationHTML = `
      <div id="ai-loading-${checkboxId}" style="background: #f0f0f0; color: #666; padding: 8px 12px; border-radius: 6px; font-size: 11px; margin-top: 10px; text-align: center;">
        <span style="animation: spin 1s linear infinite; display: inline-block;">🤖</span>
        <span style="margin-left: 6px;">AI is analyzing this cookie...</span>
      </div>
    `;
  }

  let customButtonExplanation = '';
  if (isCookieActive && cookie.potentialData && cookie.potentialData.length > 0) {
    customButtonExplanation = `
      <div style="background: #e7f3ff; padding: 8px 10px; border-radius: 4px; font-size: 10px; color: #004085; margin-top: 8px; border-left: 3px solid #007bff;">
        💡 <strong>Tip:</strong> Use checkboxes below to select which data types to allow, then click <strong>⚙️ Custom</strong>
      </div>
    `;
  }

  if (!document.getElementById('suspicious-pulse-animation')) {
    const style = document.createElement('style');
    style.id = 'suspicious-pulse-animation';
    style.textContent = `
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.7; }
      }
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  div.innerHTML = `
    <div class="cookie-header">
      <span class="cookie-name" title="${cookie.name}">
        ${statusIcon} ${truncateText(cookie.name, 25)}
      </span>
      <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
        <span class="risk-${cookie.riskLevel}">
          ${cookie.riskLevel.toUpperCase()}
        </span>
        ${suspiciousBadge}
        ${ephemeralBadge}
      </div>
    </div>
    <div class="data-types">
      <div><strong>Domain:</strong> ${cookie.domain}</div>
      <div><strong>Expires:</strong> ${getExpirationText(cookie)}</div>
      <div><strong>Status:</strong> ${statusText}</div>
      <div><strong>May collect:</strong> ${dataTypesHTML}</div>
      ${statusHTML}
      ${aiExplanationHTML}
      ${customButtonExplanation}
      ${timeInfoHTML}
    </div>
    ${isCookieActive && cookie.potentialData && cookie.potentialData.length > 0 ? `
      <div class="checkbox-group" id="checkboxes-${checkboxId}">
        ${cookie.potentialData.map(dataType => `
          <div class="checkbox-item">
            <input type="checkbox" id="${checkboxId}-${dataType}" data-type="${dataType}" ${cookie.permission && cookie.permission.allowedDataTypes.includes(dataType) ? 'checked' : 'checked'}>
            <label for="${checkboxId}-${dataType}">Allow ${dataType.replace(/_/g, ' ')}</label>
          </div>
        `).join('')}
      </div>
    ` : ''}
    <div class="actions">
      ${isCookieActive ? `
        <button class="allow-btn" data-cookie-id="${checkboxId}" title="Allow all data types for this cookie">✅ Allow All</button>
        <button class="block-btn" data-cookie-id="${checkboxId}" title="Block this cookie and remove it from browser">❌ Block</button>
        ${cookie.potentialData && cookie.potentialData.length > 0 ? 
          `<button class="customize-btn" data-cookie-id="${checkboxId}" title="Apply custom data type selections from checkboxes above">⚙️ Custom</button>` : 
          ''
        }
      ` : isBlocked ? `
        <button class="allow-btn" data-cookie-id="${checkboxId}" style="flex: 1;">🔓 Unblock Cookie</button>
      ` : isUnblockedButNotSet ? `
        <button class="customize-btn" data-cookie-id="${checkboxId}" style="flex: 1;">🔄 Refresh Page to Restore</button>
      ` : `
        <div style="text-align: center; color: #6c757d; font-size: 11px; padding: 8px;">
          ${isEphemeral ? 'This temporary cookie expired naturally.' : 'This cookie has been removed. It will reappear if the website sets it again.'}
        </div>
      `}
    </div>
  `;
  
  // If AI explanation is not yet loaded, fetch it
  if (!cookie.aiExplanation) {
    chrome.runtime.sendMessage({
      type: 'GET_AI_EXPLANATION',
      cookie: cookie
    }, (response) => {
      if (response && response.explanation) {
        const loadingEl = document.getElementById(`ai-loading-${checkboxId}`);
        if (loadingEl) {
          loadingEl.outerHTML = `
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 10px 12px; border-radius: 6px; font-size: 11px; margin-top: 10px; line-height: 1.5; box-shadow: 0 2px 4px rgba(0,0,0,0.1); animation: fadeIn 0.5s;">
              <div style="display: flex; align-items: center; margin-bottom: 6px;">
                <span style="font-size: 16px; margin-right: 6px;">🤖</span>
                <strong style="font-size: 12px;">AI Explains:</strong>
              </div>
              <div style="font-size: 11px; opacity: 0.95;">
                ${response.explanation}
              </div>
            </div>
          `;
        }
      }
    });
  }
  
  div.dataset.cookieData = JSON.stringify(cookie);
  
  const allowBtn = div.querySelector('.allow-btn');
  const blockBtn = div.querySelector('.block-btn');
  const customizeBtn = div.querySelector('.customize-btn');
  
  if (allowBtn) {
    allowBtn.addEventListener('click', async (e) => {
      const cookieData = JSON.parse(div.dataset.cookieData);
      if (isBlocked) {
        await handleUnblock(cookieData);
      } else {
        await handleCookieAction(cookieData, 'allow', checkboxId);
      }
    });
  }
  
  if (blockBtn) {
    blockBtn.addEventListener('click', async (e) => {
      const cookieData = JSON.parse(div.dataset.cookieData);
      await handleCookieAction(cookieData, 'block', checkboxId);
    });
  }
  
  if (customizeBtn) {
    customizeBtn.addEventListener('click', async (e) => {
      const cookieData = JSON.parse(div.dataset.cookieData);
      if (isUnblockedButNotSet) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
          chrome.tabs.reload(tab.id);
          showToast('🔄 Refreshing page to restore cookie...', 'info');
        }
      } else {
        await handleCookieAction(cookieData, 'custom', checkboxId);
      }
    });
  }
  
  return div;
}

async function handleUnblock(cookie) {
  const permissionKey = `cookie_${cookie.name}_${cookie.domain}`;
  
  const modal = document.createElement('div');
  modal.id = 'unblock-modal';
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10002;
  `;
  
  modal.innerHTML = `
    <div style="background: white; padding: 20px; border-radius: 12px; max-width: 350px; box-shadow: 0 8px 32px rgba(0,0,0,0.3);">
      <div style="font-size: 16px; font-weight: bold; margin-bottom: 12px; color: #333;">
        🔓 Unblock Cookie
      </div>
      <div style="font-size: 13px; color: #666; margin-bottom: 16px; line-height: 1.5;">
        <strong style="color: #007bff;">${cookie.name}</strong> will be unblocked.
        <br><br>
        <strong>What would you like to do?</strong>
      </div>
      <div style="display: flex; flex-direction: column; gap: 10px;">
        <button id="unblock-refresh-btn" style="background: #28a745; color: white; border: none; padding: 12px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;">
          🔄 Unblock & Refresh Page
          <div style="font-size: 10px; opacity: 0.9; margin-top: 4px;">Recommended - Cookie will be restored immediately</div>
        </button>
        <button id="unblock-only-btn" style="background: #007bff; color: white; border: none; padding: 12px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;">
          ✓ Unblock Only
          <div style="font-size: 10px; opacity: 0.9; margin-top: 4px;">Cookie will be allowed on next visit</div>
        </button>
        <button id="cancel-unblock-btn" style="background: #6c757d; color: white; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-size: 12px;">
          Cancel
        </button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  document.getElementById('unblock-refresh-btn').addEventListener('click', async () => {
    modal.remove();
    await chrome.storage.sync.remove([permissionKey]);
    showToast(`🔓 Unblocked ${cookie.name}. Refreshing page...`, 'success');
    await updateStats();
    setTimeout(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        chrome.tabs.reload(tab.id);
      }
    }, 500);
  });
  
  document.getElementById('unblock-only-btn').addEventListener('click', async () => {
    modal.remove();
    await chrome.storage.sync.remove([permissionKey]);
    showToast(`🔓 Unblocked ${cookie.name}. Cookie will be allowed on next page load.`, 'success');
    setTimeout(async () => {
      await updateStats();
      await loadCurrentTabCookies();
    }, 300);
  });
  
  document.getElementById('cancel-unblock-btn').addEventListener('click', () => {
    modal.remove();
  });
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });
}

async function handleCookieAction(cookie, action, checkboxId) {
  let dataTypesToAllow = [];
  
  if (action === 'allow') {
    dataTypesToAllow = cookie.potentialData || [];
    showToast(`✅ Allowed all data for ${cookie.name}`, 'success');
  } else if (action === 'block') {
    dataTypesToAllow = [];
    showToast(`❌ Blocked ${cookie.name}. Cookie removed from browser.`, 'error');
    
    try {
      const protocol = cookie.secure ? 'https:' : 'http:';
      const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
      const url = `${protocol}//${domain}${cookie.path || '/'}`;
      
      await chrome.cookies.remove({
        url: url,
        name: cookie.name
      });
      console.log('Cookie removed:', cookie.name);
    } catch (error) {
      console.error('Error removing cookie:', error);
    }
  } else if (action === 'custom') {
    const checkboxes = document.querySelectorAll(`#checkboxes-${checkboxId} input[type="checkbox"]`);
    checkboxes.forEach(checkbox => {
      if (checkbox.checked) {
        dataTypesToAllow.push(checkbox.dataset.type);
      }
    });
    
    if (dataTypesToAllow.length === 0) {
      try {
        const protocol = cookie.secure ? 'https:' : 'http:';
        const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
        const url = `${protocol}//${domain}${cookie.path || '/'}`;
        
        await chrome.cookies.remove({
          url: url,
          name: cookie.name
        });
        
        showToast(`❌ No data types selected. Cookie blocked.`, 'error');
      } catch (error) {
        console.error('Error removing cookie:', error);
      }
    } else {
      showToast(`⚙️ Custom settings applied for ${cookie.name} (${dataTypesToAllow.length} data types allowed)`, 'info');
    }
  }
  
  await chrome.runtime.sendMessage({
    type: 'UPDATE_COOKIE_PERMISSIONS',
    cookie: cookie,
    allowedDataTypes: dataTypesToAllow,
    action: action
  });
  
  setTimeout(async () => {
    await updateStats();
    await loadCurrentTabCookies();
  }, 300);
}

function setupEventListeners() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
      
      item.classList.add('active');
      document.getElementById(`${item.dataset.tab}-tab`).classList.add('active');
    });
  });
  
  document.getElementById('save-settings').addEventListener('click', saveSettings);
  document.getElementById('clear-data').addEventListener('click', clearData);
  document.getElementById('export-data').addEventListener('click', exportData);
}

function loadSettings() {
  chrome.storage.sync.get([
    'autoBlockHighRisk',
    'showNotifications',
    'defaultPermissions'
  ], (result) => {
    document.getElementById('auto-block-high-risk').checked = result.autoBlockHighRisk || false;
    document.getElementById('show-notifications').checked = result.showNotifications !== false;
    
    const defaultPermissions = result.defaultPermissions || {
      email: true,
      location: true,
      device_info: true,
      browsing_behavior: true,
      social_media_data: true,
      marketing_data: true
    };
    
    document.getElementById('allow-email').checked = defaultPermissions.email !== false;
    document.getElementById('allow-location').checked = defaultPermissions.location !== false;
    document.getElementById('allow-device').checked = defaultPermissions.device_info !== false;
    document.getElementById('allow-behavior').checked = defaultPermissions.browsing_behavior !== false;
    document.getElementById('allow-social').checked = defaultPermissions.social_media_data !== false;
    document.getElementById('allow-marketing').checked = defaultPermissions.marketing_data !== false;
  });
}

function saveSettings() {
  const settings = {
    autoBlockHighRisk: document.getElementById('auto-block-high-risk').checked,
    showNotifications: document.getElementById('show-notifications').checked,
    defaultPermissions: {
      email: document.getElementById('allow-email').checked,
      location: document.getElementById('allow-location').checked,
      device_info: document.getElementById('allow-device').checked,
      browsing_behavior: document.getElementById('allow-behavior').checked,
      social_media_data: document.getElementById('allow-social').checked,
      marketing_data: document.getElementById('allow-marketing').checked
    }
  };
  
  chrome.storage.sync.set(settings, () => {
    showToast('✅ Settings saved successfully!', 'success');
  });
}

function clearData() {
  if (confirm('Are you sure you want to clear all cookie permissions and settings? This will not delete the actual cookies, only your preferences.')) {
    chrome.storage.sync.clear(async () => {
      chrome.storage.local.remove(['cookieHistory', 'cookieExplanations'], async () => {
        showToast('✅ All preferences and history cleared successfully!', 'success');
        loadSettings();
        await updateStats();
        await loadCurrentTabCookies();
      });
    });
  }
}

async function exportData() {
  try {
    showToast('📤 Preparing export...', 'info');
    
    const response = await chrome.runtime.sendMessage({ type: 'GET_ALL_COOKIE_DATA' });
    
    if (response.error) {
      showToast('❌ Error: ' + response.error, 'error');
      return;
    }
    
    if (!response.cookies || response.cookies.length === 0) {
      showToast('⚠️ No cookie data to export', 'error');
      return;
    }
    
    const exportData = {
      exportInfo: {
        extensionName: 'Cookie Privacy Guard',
        exportDate: response.exportDate,
        website: response.website,
        version: '1.0'
      },
      statistics: response.stats,
      cookies: response.cookies,
      userPermissions: response.permissions,
      settings: response.settings
    };
    
    const dataStr = JSON.stringify(exportData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    a.download = `cookie-guard-export-${response.website}-${timestamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast(`📤 Exported ${response.cookies.length} cookies successfully!`, 'success');
  } catch (error) {
    console.error('Export error:', error);
    showToast('❌ Export failed: ' + error.message, 'error');
  }
}

async function updateStats() {
  try {
    if (!currentTabUrl) return;
    
    const response = await chrome.runtime.sendMessage({ type: 'GET_ALL_COOKIE_DATA' });
    
    if (response.cookies) {
      let suspiciousCount = 0;
      let blockedCount = 0;
      let allowedCount = 0;
      
      for (const cookie of response.cookies) {
        if (cookie.riskScore >= 3) {
          suspiciousCount++;
        }
        
        const isBlocked = cookie.permission && cookie.permission.blocked && cookie.value === '[BLOCKED/REMOVED]';
        if (isBlocked) {
          blockedCount++;
        }
        
        if (cookie.permission) {
          if (cookie.permission.action === 'allow') {
            allowedCount++;
          } else if (cookie.permission.action === 'custom' && cookie.permission.allowedDataTypes.length > 0) {
            allowedCount++;
          }
        }
      }
      
      const stats = {
        total: response.cookies.length,
        suspicious: suspiciousCount,
        blocked: blockedCount,
        allowed: allowedCount
      };
      
      displayStats(stats);
    }
  } catch (error) {
    console.error('Error updating stats:', error);
  }
}

function displayStats(stats) {
  document.getElementById('total-cookies').textContent = stats.total || 0;
  document.getElementById('suspicious-cookies').textContent = stats.suspicious || 0;
  document.getElementById('blocked-cookies').textContent = stats.blocked || 0;
}

function truncateText(text, maxLength) {
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

function getExpirationText(cookie) {
  const isBlocked = cookie.permission && cookie.permission.blocked && cookie.value === '[BLOCKED/REMOVED]';
  const isUnblockedButNotSet = !isBlocked && cookie.value === '[BLOCKED/REMOVED]';
  const isRemoved = cookie.status === 'removed';
  
  if (isBlocked) return 'N/A (Blocked)';
  if (isUnblockedButNotSet) return 'N/A (Not Set)';
  if (isRemoved) return 'N/A (Removed)';
  if (!cookie.expirationDate) return 'Session';
  
  const now = Date.now() / 1000;
  const diff = cookie.expirationDate - now;
  
  if (diff < 0) return 'Expired';
  if (diff < 60) return '< 1 min';
  if (diff < 3600) return Math.floor(diff / 60) + ' min';
  if (diff < 86400) return Math.floor(diff / 3600) + ' hours';
  if (diff < 2592000) return Math.floor(diff / 86400) + ' days';
  if (diff < 31536000) return Math.floor(diff / 2592000) + ' months';
  return Math.floor(diff / 31536000) + ' years';
}

function showToast(message, type = 'info') {
  const existingToast = document.getElementById('cookie-toast');
  if (existingToast) existingToast.remove();
  
  const toast = document.createElement('div');
  toast.id = 'cookie-toast';
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: ${type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#007bff'};
    color: white;
    padding: 12px 20px;
    border-radius: 6px;
    z-index: 10001;
    font-size: 12px;
    font-weight: 500;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: slideUp 0.3s ease;
  `;
  
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideUp {
      from { transform: translateX(-50%) translateY(100%); opacity: 0; }
      to { transform: translateX(-50%) translateY(0); opacity: 1; }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  if (!document.querySelector('style[data-toast]')) {
    style.setAttribute('data-toast', 'true');
    document.head.appendChild(style);
  }
  
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    if (toast.parentNode) {
      toast.remove();
    }
  }, 3000);
}
