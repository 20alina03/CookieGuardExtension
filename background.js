// Background service worker for cookie monitoring
console.log('Cookie Privacy Guard background script loaded');

let activeTabDomain = '';
let cookieStats = {
  total: 0,
  suspicious: 0,
  blocked: 0,
  allowed: 0
};

// Store blocked cookies history to maintain count
let blockedCookiesHistory = new Set();

// Update active tab domain when tab changes
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && tab.url.startsWith('http')) {
      activeTabDomain = new URL(tab.url).hostname;
      console.log('Active domain updated:', activeTabDomain);
      await updateCookieStats(tab.url);
    }
  } catch (error) {
    console.log('Error updating active tab:', error);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
    activeTabDomain = new URL(tab.url).hostname;
    console.log('Active domain updated (tab updated):', activeTabDomain);
    await scanExistingCookies(tab.url);
    await updateCookieStats(tab.url);
  }
});

// Monitor cookie changes
chrome.cookies.onChanged.addListener(async (changeInfo) => {
  if (!changeInfo.removed) {
    await analyzeCookie(changeInfo.cookie);
    // Check if cookie should be blocked
    const shouldBlock = await shouldBlockCookie(changeInfo.cookie);
    if (shouldBlock) {
      const cookieKey = `${changeInfo.cookie.name}_${changeInfo.cookie.domain}`;
      blockedCookiesHistory.add(cookieKey);
      
      await chrome.cookies.remove({
        url: getCookieUrl(changeInfo.cookie),
        name: changeInfo.cookie.name
      });
      console.log('Blocked cookie:', changeInfo.cookie.name);
    }
  }
  
  // Update stats when cookies change
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0 && tabs[0].url) {
    await updateCookieStats(tabs[0].url);
  }
});

// Scan cookies when navigation completes
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.url && details.url.startsWith('http')) {
    scanExistingCookies(details.url);
  }
});

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'CONTENT_SCRIPT_LOADED':
      console.log('Content script loaded for:', message.url);
      break;
      
    case 'OPEN_POPUP':
      chrome.action.openPopup();
      break;
      
    case 'GET_ACTIVE_TAB':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        sendResponse(tabs[0]);
      });
      return true;
      
    case 'UPDATE_COOKIE_PERMISSIONS':
      handleCookiePermissionsUpdate(message.cookie, message.allowedDataTypes, message.action)
        .then(() => {
          sendResponse({ success: true });
        });
      return true;
      
    case 'GET_COOKIE_STATS':
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (tabs.length > 0 && tabs[0].url) {
          const stats = await updateCookieStats(tabs[0].url);
          sendResponse(stats);
        }
      });
      return true;
      
    case 'GET_ALL_COOKIE_DATA':
      getAllCookieData().then(data => {
        sendResponse(data);
      });
      return true;
  }
});

async function analyzeCookie(cookie) {
  try {
    const riskScore = await calculateRiskScore(cookie);
    
    // Check settings for notifications
    const settings = await chrome.storage.sync.get(['showNotifications']);
    
    if (riskScore >= 2 && settings.showNotifications !== false) {
      console.log(`Suspicious cookie detected: ${cookie.name} (Risk: ${riskScore})`);
      
      // Try to send to content script for notification
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].url && tabs[0].url.startsWith('http')) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'SUSPICIOUS_COOKIE',
          cookie: cookie,
          riskScore: riskScore
        }).catch(error => {
          // Content script might not be ready, this is normal
        });
      }
    }
  } catch (error) {
    console.log('Error analyzing cookie:', error);
  }
}

async function calculateRiskScore(cookie) {
  let score = 0;
  
  // Check for tracking patterns in cookie name and value
  const trackingPatterns = ['_ga', '_gid', '_fbp', 'fr', 'track', 'uid', 'id', 'analytics', 'ad', 'pixel'];
  const cookieStr = (cookie.name + cookie.value).toLowerCase();
  
  trackingPatterns.forEach(pattern => {
    if (cookieStr.includes(pattern)) score += 1;
  });
  
  // Check for third-party cookies
  try {
    if (activeTabDomain && !isSameDomain(cookie.domain, activeTabDomain)) {
      score += 2; // Third-party cookie
    }
  } catch (error) {
    console.log('Error checking cookie domain:', error);
  }
  
  // Check expiration (long-lived cookies are more suspicious)
  if (cookie.expirationDate && cookie.expirationDate > (Date.now() / 1000) + 31536000) {
    score += 1;
  }
  
  // Check secure flag (non-secure cookies on HTTPS sites)
  if (!cookie.secure && activeTabDomain && activeTabDomain.startsWith('https://')) {
    score += 1;
  }
  
  return score;
}

function isSameDomain(cookieDomain, currentDomain) {
  try {
    const normalizeDomain = (domain) => {
      return domain.replace(/^\./, '').toLowerCase();
    };
    
    const normCookieDomain = normalizeDomain(cookieDomain);
    const normCurrentDomain = normalizeDomain(currentDomain);
    
    return normCurrentDomain.endsWith(normCookieDomain) || normCookieDomain.endsWith(normCurrentDomain);
  } catch (error) {
    return false;
  }
}

async function scanExistingCookies(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    console.log(`Found ${cookies.length} cookies for ${url}`);
    
    // Check auto-block settings
    const settings = await chrome.storage.sync.get(['autoBlockHighRisk']);
    
    for (const cookie of cookies) {
      await analyzeCookie(cookie);
      
      // Auto-block high-risk cookies if enabled
      if (settings.autoBlockHighRisk) {
        const riskScore = await calculateRiskScore(cookie);
        if (riskScore >= 5) {
          const cookieKey = `${cookie.name}_${cookie.domain}`;
          blockedCookiesHistory.add(cookieKey);
          
          await chrome.cookies.remove({
            url: getCookieUrl(cookie),
            name: cookie.name
          });
          console.log('Auto-blocked high-risk cookie:', cookie.name);
          
          // Store block action
          const permissionKey = `cookie_${cookie.name}_${cookie.domain}`;
          await chrome.storage.sync.set({
            [permissionKey]: {
              allowedDataTypes: [],
              action: 'block',
              timestamp: Date.now(),
              cookieName: cookie.name,
              cookieDomain: cookie.domain,
              autoBlocked: true
            }
          });
        }
      }
    }
  } catch (error) {
    console.log('Error scanning cookies:', error);
  }
}

async function handleCookiePermissionsUpdate(cookie, allowedDataTypes, action) {
  console.log(`Cookie permission updated: ${cookie.name} - ${action}`, allowedDataTypes);
  
  const permissionKey = `cookie_${cookie.name}_${cookie.domain}`;
  const cookieKey = `${cookie.name}_${cookie.domain}`;
  
  // Store the user's preference
  await chrome.storage.sync.set({
    [permissionKey]: {
      allowedDataTypes: allowedDataTypes,
      action: action,
      timestamp: Date.now(),
      cookieName: cookie.name,
      cookieDomain: cookie.domain,
      potentialData: cookie.potentialData || [],
      blocked: action === 'block' || (action === 'custom' && allowedDataTypes.length === 0)
    }
  });
  
  // Actually block the cookie if action is 'block'
  if (action === 'block' || (action === 'custom' && allowedDataTypes.length === 0)) {
    try {
      blockedCookiesHistory.add(cookieKey);
      
      await chrome.cookies.remove({
        url: getCookieUrl(cookie),
        name: cookie.name
      });
      console.log('Cookie blocked and removed:', cookie.name);
    } catch (error) {
      console.error('Error removing cookie:', error);
    }
  } else {
    // If allowing, remove from blocked history
    blockedCookiesHistory.delete(cookieKey);
  }
  
  // Update stats after permission change
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0 && tabs[0].url) {
    await updateCookieStats(tabs[0].url);
  }
}

async function shouldBlockCookie(cookie) {
  try {
    const permissionKey = `cookie_${cookie.name}_${cookie.domain}`;
    const result = await chrome.storage.sync.get([permissionKey]);
    
    if (result[permissionKey]) {
      const permission = result[permissionKey];
      return permission.action === 'block' || 
             (permission.action === 'custom' && permission.allowedDataTypes.length === 0);
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

function getCookieUrl(cookie) {
  const protocol = cookie.secure ? 'https:' : 'http:';
  const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
  return `${protocol}//${domain}${cookie.path}`;
}

async function updateCookieStats(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    const allPermissions = await chrome.storage.sync.get(null);
    
    let suspiciousCount = 0;
    let blockedCount = 0;
    let allowedCount = 0;
    
    // Track all cookies (current + blocked)
    const allCookieKeys = new Set();
    
    // Add current cookies
    for (const cookie of cookies) {
      const cookieKey = `${cookie.name}_${cookie.domain}`;
      allCookieKeys.add(cookieKey);
      
      const riskScore = await calculateRiskScore(cookie);
      if (riskScore >= 3) {
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
    
    // Count blocked cookies from permissions
    for (const [key, value] of Object.entries(allPermissions)) {
      if (key.startsWith('cookie_') && value.blocked) {
        const cookieKey = `${value.cookieName}_${value.cookieDomain}`;
        
        // Add to all cookies count if not already present
        if (!allCookieKeys.has(cookieKey)) {
          allCookieKeys.add(cookieKey);
          
          // Check if it was suspicious when blocked
          if (value.potentialData && value.potentialData.length >= 3) {
            suspiciousCount++;
          }
        }
        
        blockedCount++;
      }
    }
    
    const totalCount = allCookieKeys.size;
    
    cookieStats = {
      total: totalCount,
      suspicious: suspiciousCount,
      blocked: blockedCount,
      allowed: allowedCount
    };
    
    console.log('Updated stats:', cookieStats);
    
    // Broadcast stats update to popup
    chrome.runtime.sendMessage({
      type: 'STATS_UPDATED',
      stats: cookieStats
    }).catch(() => {
      // Popup might not be open
    });
    
    return cookieStats;
  } catch (error) {
    console.error('Error updating stats:', error);
    return cookieStats;
  }
}

async function getAllCookieData() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0 || !tabs[0].url) {
      return { cookies: [], permissions: {}, settings: {} };
    }
    
    const url = tabs[0].url;
    const cookies = await chrome.cookies.getAll({ url });
    const allData = await chrome.storage.sync.get(null);
    
    // Separate permissions from settings
    const permissions = {};
    const settings = {};
    
    for (const [key, value] of Object.entries(allData)) {
      if (key.startsWith('cookie_')) {
        permissions[key] = value;
      } else {
        settings[key] = value;
      }
    }
    
    // Analyze each cookie (including blocked ones from history)
    const analyzedCookies = [];
    const processedCookies = new Set();
    
    // Process current cookies
    for (const cookie of cookies) {
      const cookieKey = `${cookie.name}_${cookie.domain}`;
      processedCookies.add(cookieKey);
      
      const potentialData = detectPotentialData(cookie);
      const riskScore = await calculateRiskScore(cookie);
      
      let riskLevel = 'low';
      if (riskScore >= 5) riskLevel = 'high';
      else if (riskScore >= 3) riskLevel = 'medium';
      
      const permissionKey = `cookie_${cookie.name}_${cookie.domain}`;
      const permission = permissions[permissionKey] || null;
      
      analyzedCookies.push({
        name: cookie.name,
        domain: cookie.domain,
        value: cookie.value,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expirationDate,
        potentialData: potentialData,
        riskLevel: riskLevel,
        riskScore: riskScore,
        permission: permission,
        status: permission && permission.blocked ? 'blocked' : 'active'
      });
    }
    
    // Add blocked cookies that are no longer present
    for (const [key, value] of Object.entries(permissions)) {
      if (value.blocked) {
        const cookieKey = `${value.cookieName}_${value.cookieDomain}`;
        if (!processedCookies.has(cookieKey)) {
          analyzedCookies.push({
            name: value.cookieName,
            domain: value.cookieDomain,
            value: '[BLOCKED]',
            potentialData: value.potentialData || [],
            riskLevel: 'high',
            permission: value,
            status: 'blocked'
          });
        }
      }
    }
    
    return {
      exportDate: new Date().toISOString(),
      website: new URL(url).hostname,
      cookies: analyzedCookies,
      permissions: permissions,
      settings: settings,
      stats: cookieStats
    };
  } catch (error) {
    console.error('Error getting all cookie data:', error);
    return { cookies: [], permissions: {}, settings: {}, error: error.message };
  }
}

function detectPotentialData(cookie) {
  const dataTypes = [];
  const cookieStr = (cookie.name + '=' + cookie.value).toLowerCase();
  
  const dataPatterns = {
    'email': ['email', 'mail', '@'],
    'name': ['name', 'user', 'username', 'fullname', 'firstname', 'lastname'],
    'location': ['location', 'geo', 'lat', 'long', 'gps', 'address', 'city', 'country', 'zip'],
    'device_info': ['device', 'os', 'browser', 'platform', 'useragent', 'screen', 'resolution', 'mobile'],
    'ip_address': ['ip', 'address', 'remoteaddr', 'clientip'],
    'browsing_behavior': ['behavior', 'click', 'scroll', 'movement', 'activity', 'history', 'visit'],
    'preferences': ['preference', 'setting', 'config', 'theme', 'language', 'currency'],
    'session_data': ['session', 'login', 'token', 'auth', 'password', 'credential'],
    'marketing_data': ['ad', 'marketing', 'campaign', 'tracking', 'analytics', 'conversion'],
    'social_media_data': ['social', 'facebook', 'twitter', 'linkedin', 'instagram', 'google', 'youtube'],
    'shopping_data': ['cart', 'basket', 'purchase', 'product', 'item', 'price'],
    'demographic_data': ['age', 'gender', 'birth', 'income', 'education']
  };
  
  for (const [dataType, patterns] of Object.entries(dataPatterns)) {
    if (patterns.some(pattern => cookieStr.includes(pattern))) {
      dataTypes.push(dataType);
    }
  }
  
  return [...new Set(dataTypes)];
}

// Initialize active tab domain on startup
chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
  if (tabs.length > 0 && tabs[0].url && tabs[0].url.startsWith('http')) {
    activeTabDomain = new URL(tabs[0].url).hostname;
    console.log('Initial active domain:', activeTabDomain);
    await updateCookieStats(tabs[0].url);
  }
});