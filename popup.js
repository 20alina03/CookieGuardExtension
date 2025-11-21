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
      
      // Get cookies for current site
      const cookies = await chrome.cookies.getAll({ url: tab.url });
      
      // Get all permissions to include blocked cookies
      const allPermissions = await chrome.storage.sync.get(null);
      
      // Combine current cookies with blocked cookies
      const allCookies = [...cookies];
      const cookieKeys = new Set(cookies.map(c => `${c.name}_${c.domain}`));
      
      // Add blocked cookies that are no longer present
      for (const [key, value] of Object.entries(allPermissions)) {
        if (key.startsWith('cookie_') && value.blocked) {
          const cookieKey = `${value.cookieName}_${value.cookieDomain}`;
          if (!cookieKeys.has(cookieKey)) {
            // Create a pseudo-cookie object for blocked cookie
            allCookies.push({
              name: value.cookieName,
              domain: value.cookieDomain,
              value: '[BLOCKED]',
              path: '/',
              secure: false,
              httpOnly: false,
              blocked: true,
              permission: value,
              potentialData: value.potentialData || []
            });
          }
        }
      }
      
      const cookiesList = document.getElementById('cookies-list');
      
      await updateStats();
      
      if (allCookies.length === 0) {
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
      
      // Sort cookies by risk level
      const analyzedCookies = await Promise.all(
        allCookies.map(cookie => analyzeCookieData(cookie))
      );
      analyzedCookies.sort((a, b) => {
        // Blocked cookies first, then by risk score
        if (a.isBlocked && !b.isBlocked) return -1;
        if (!a.isBlocked && b.isBlocked) return 1;
        return b.riskScore - a.riskScore;
      });
      
      for (const cookie of analyzedCookies) {
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

async function analyzeCookieData(cookie) {
  // Check if cookie is already marked as blocked
  const permissionKey = `cookie_${cookie.name}_${cookie.domain}`;
  const stored = await chrome.storage.sync.get([permissionKey]);
  const permission = stored[permissionKey] || null;
  
  const isBlocked = cookie.blocked || (permission && permission.blocked);
  
  let potentialData = cookie.potentialData || detectPotentialData(cookie);
  let riskScore = potentialData.length;
  
  // Check if it's third-party
  if (currentTabUrl && cookie.value !== '[BLOCKED]') {
    const currentDomain = new URL(currentTabUrl).hostname;
    const cookieDomain = cookie.domain.replace(/^\./, '');
    if (!currentDomain.includes(cookieDomain) && !cookieDomain.includes(currentDomain)) {
      riskScore += 2;
    }
  }
  
  // Long expiration
  if (cookie.expirationDate && cookie.expirationDate > Date.now() / 1000 + 31536000) {
    riskScore += 1;
  }
  
  // Not secure
  if (!cookie.secure && currentTabUrl && currentTabUrl.startsWith('https')) {
    riskScore += 1;
  }
  
  // Blocked cookies are high risk
  if (isBlocked) {
    riskScore = Math.max(riskScore, 5);
  }
  
  let riskLevel = 'low';
  if (riskScore >= 5) riskLevel = 'high';
  else if (riskScore >= 3) riskLevel = 'medium';
  
  return {
    ...cookie,
    potentialData: potentialData,
    riskLevel: riskLevel,
    riskScore: riskScore,
    permission: permission,
    isBlocked: isBlocked
  };
}

function detectPotentialData(cookie) {
  const dataTypes = [];
  const cookieStr = (cookie.name + '=' + cookie.value).toLowerCase();
  
  const dataPatterns = {
    'email': ['email', '@', 'mail'],
    'name': ['name', 'user', 'username', 'fullname'],
    'location': ['location', 'geo', 'lat', 'long', 'gps', 'address'],
    'device_info': ['device', 'os', 'browser', 'platform', 'useragent'],
    'ip_address': ['ip', 'address'],
    'browsing_behavior': ['behavior', 'click', 'scroll', 'movement', 'activity'],
    'preferences': ['preference', 'setting', 'config', 'theme'],
    'session_data': ['session', 'login', 'token', 'auth'],
    'marketing_data': ['ad', 'marketing', 'campaign', 'tracking', 'analytics'],
    'social_media_data': ['social', 'facebook', 'twitter', 'linkedin', 'instagram', 'google']
  };
  
  for (const [dataType, patterns] of Object.entries(dataPatterns)) {
    if (patterns.some(pattern => cookieStr.includes(pattern))) {
      dataTypes.push(dataType);
    }
  }
  
  return [...new Set(dataTypes)];
}

async function createCookieElement(cookie) {
  const div = document.createElement('div');
  div.className = 'cookie-item';
  const checkboxId = cookie.name.replace(/[^a-zA-Z0-9]/g, '-') + '-' + Date.now();
  
  // Add visual styling for blocked cookies
  if (cookie.isBlocked) {
    div.style.opacity = '0.7';
    div.style.border = '2px solid #dc3545';
    div.style.background = '#fff5f5';
  }
  
  const dataTypesHTML = cookie.potentialData.length > 0 
    ? cookie.potentialData.map(dt => dt.replace(/_/g, ' ')).join(', ')
    : '<em style="color: #999;">No specific data types detected</em>';

  // Show current permission status
  let statusHTML = '';
  if (cookie.isBlocked) {
    statusHTML = '<div style="background: #f8d7da; color: #721c24; padding: 6px 10px; border-radius: 4px; font-size: 11px; margin-top: 8px; font-weight: bold;">🚫 BLOCKED - Cookie Removed from Browser</div>';
  } else if (cookie.permission) {
    const action = cookie.permission.action;
    if (action === 'allow') {
      statusHTML = '<div style="background: #d4edda; color: #155724; padding: 4px 8px; border-radius: 4px; font-size: 10px; margin-top: 8px;">✅ Currently Allowed</div>';
    } else if (action === 'custom') {
      statusHTML = `<div style="background: #d1ecf1; color: #0c5460; padding: 4px 8px; border-radius: 4px; font-size: 10px; margin-top: 8px;">⚙️ Custom (${cookie.permission.allowedDataTypes.length} types allowed)</div>`;
    }
  }

  div.innerHTML = `
    <div class="cookie-header">
      <span class="cookie-name" title="${cookie.name}">
        ${cookie.isBlocked ? '🚫 ' : ''}${truncateText(cookie.name, 25)}
      </span>
      <span class="risk-${cookie.riskLevel}">
        ${cookie.riskLevel.toUpperCase()}
      </span>
    </div>
    <div class="data-types">
      <div><strong>Domain:</strong> ${cookie.domain}</div>
      <div><strong>Expires:</strong> ${getExpirationText(cookie)}</div>
      <div><strong>Status:</strong> ${cookie.isBlocked ? '<span style="color: #dc3545; font-weight: bold;">BLOCKED</span>' : '<span style="color: #28a745;">Active</span>'}</div>
      <div><strong>May collect:</strong> ${dataTypesHTML}</div>
      ${statusHTML}
    </div>
    ${!cookie.isBlocked && cookie.potentialData.length > 0 ? `
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
      ${!cookie.isBlocked ? `
        <button class="allow-btn" data-cookie-id="${checkboxId}">✅ Allow All</button>
        <button class="block-btn" data-cookie-id="${checkboxId}">❌ Block</button>
        ${cookie.potentialData.length > 0 ? 
          `<button class="customize-btn" data-cookie-id="${checkboxId}">⚙️ Custom</button>` : 
          ''
        }
      ` : `
        <button class="allow-btn" data-cookie-id="${checkboxId}" style="flex: 1;">🔓 Unblock Cookie</button>
      `}
    </div>
  `;
  
  // Store cookie data on the element
  div.dataset.cookieData = JSON.stringify(cookie);
  
  // Add event listeners
  const allowBtn = div.querySelector('.allow-btn');
  const blockBtn = div.querySelector('.block-btn');
  const customizeBtn = div.querySelector('.customize-btn');
  
  if (allowBtn) {
    allowBtn.addEventListener('click', async (e) => {
      const cookieData = JSON.parse(div.dataset.cookieData);
      if (cookieData.isBlocked) {
        // Unblock the cookie
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
      await handleCookieAction(cookieData, 'custom', checkboxId);
    });
  }
  
  return div;
}

async function handleUnblock(cookie) {
  const permissionKey = `cookie_${cookie.name}_${cookie.domain}`;
  
  // Remove the block permission
  await chrome.storage.sync.remove([permissionKey]);
  
  showToast(`🔓 Unblocked ${cookie.name}. Refresh the page to restore this cookie.`, 'success');
  
  // Immediately update stats and refresh list
  setTimeout(async () => {
    await updateStats();
    await loadCurrentTabCookies();
  }, 300);
}

async function handleCookieAction(cookie, action, checkboxId) {
  let dataTypesToAllow = [];
  
  if (action === 'allow') {
    dataTypesToAllow = cookie.potentialData;
    showToast(`✅ Allowed all data for ${cookie.name}`, 'success');
  } else if (action === 'block') {
    dataTypesToAllow = [];
    showToast(`❌ Blocked ${cookie.name}. Cookie removed from browser.`, 'error');
    
    // Actually remove the cookie
    try {
      const protocol = cookie.secure ? 'https:' : 'http:';
      const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
      const url = `${protocol}//${domain}${cookie.path}`;
      
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
      // Remove cookie if no data types allowed
      try {
        const protocol = cookie.secure ? 'https:' : 'http:';
        const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
        const url = `${protocol}//${domain}${cookie.path}`;
        
        await chrome.cookies.remove({
          url: url,
          name: cookie.name
        });
        
        showToast(`❌ No data types selected. Cookie blocked.`, 'error');
      } catch (error) {
        console.error('Error removing cookie:', error);
      }
    } else {
      showToast(`⚙️ Custom settings applied for ${cookie.name}`, 'info');
    }
  }
  
  // Store the user's preferences
  await chrome.runtime.sendMessage({
    type: 'UPDATE_COOKIE_PERMISSIONS',
    cookie: cookie,
    allowedDataTypes: dataTypesToAllow,
    action: action
  });
  
  // Immediately update stats and refresh list
  setTimeout(async () => {
    await updateStats();
    await loadCurrentTabCookies();
  }, 300);
}

function setupEventListeners() {
  // Tab navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
      
      item.classList.add('active');
      document.getElementById(`${item.dataset.tab}-tab`).classList.add('active');
    });
  });
  
  // Save settings
  document.getElementById('save-settings').addEventListener('click', saveSettings);
  
  // Tools
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
      showToast('✅ All preferences cleared successfully!', 'success');
      loadSettings();
      await updateStats();
      await loadCurrentTabCookies();
    });
  }
}

async function exportData() {
  try {
    showToast('📤 Preparing export...', 'info');
    
    // Get all cookie data from background script
    const response = await chrome.runtime.sendMessage({ type: 'GET_ALL_COOKIE_DATA' });
    
    if (response.error) {
      showToast('❌ Error: ' + response.error, 'error');
      return;
    }
    
    if (!response.cookies || response.cookies.length === 0) {
      showToast('⚠️ No cookie data to export', 'error');
      return;
    }
    
    // Create formatted export data
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
    
    const cookies = await chrome.cookies.getAll({ url: currentTabUrl });
    const allPermissions = await chrome.storage.sync.get(null);
    
    let suspiciousCount = 0;
    let blockedCount = 0;
    let allowedCount = 0;
    
    // Track all cookies
    const allCookieKeys = new Set();
    
    // Count current cookies
    for (const cookie of cookies) {
      const cookieKey = `${cookie.name}_${cookie.domain}`;
      allCookieKeys.add(cookieKey);
      
      const analyzed = await analyzeCookieData(cookie);
      if (analyzed.riskScore >= 3) {
        suspiciousCount++;
      }
      
      const permissionKey = `cookie_${cookie.name}_${cookie.domain}`;
      if (allPermissions[permissionKey]) {
        const permission = allPermissions[permissionKey];
        if (permission.action === 'allow') {
          allowedCount++;
        } else if (permission.action === 'custom' && permission.allowedDataTypes.length > 0) {
          allowedCount++;
        }
      }
    }
    
    // Count blocked cookies
    for (const [key, value] of Object.entries(allPermissions)) {
      if (key.startsWith('cookie_') && value.blocked) {
        const cookieKey = `${value.cookieName}_${value.cookieDomain}`;
        
        // Add to total if not already counted
        if (!allCookieKeys.has(cookieKey)) {
          allCookieKeys.add(cookieKey);
          
          // Blocked cookies might have been suspicious
          if (value.potentialData && value.potentialData.length >= 3) {
            suspiciousCount++;
          }
        }
        
        blockedCount++;
      }
    }
    
    const stats = {
      total: allCookieKeys.size,
      suspicious: suspiciousCount,
      blocked: blockedCount,
      allowed: allowedCount
    };
    
    displayStats(stats);
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
  if (cookie.isBlocked) return 'N/A (Blocked)';
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