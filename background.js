// Background service worker for cookie monitoring
console.log('Cookie Privacy Guard background script loaded');

let activeTabDomain = '';
let cookieStats = {
  total: 0,
  suspicious: 0,
  blocked: 0,
  allowed: 0
};

// Store complete cookie history with full details
let cookieHistory = new Map();
let cookieExplanations = new Map(); // Cache AI explanations

// Groq API configuration (FREE)
const key = "";

// Load cookie history and explanations from storage on startup
chrome.storage.local.get(['cookieHistory', 'cookieExplanations'], (result) => {
  if (result.cookieHistory) {
    cookieHistory = new Map(Object.entries(result.cookieHistory));
    console.log('Loaded cookie history:', cookieHistory.size, 'cookies');
  }
  if (result.cookieExplanations) {
    cookieExplanations = new Map(Object.entries(result.cookieExplanations));
    console.log('Loaded cookie explanations:', cookieExplanations.size, 'explanations');
  }
});

// Save cookie history to storage periodically
function saveCookieHistory() {
  const historyObj = Object.fromEntries(cookieHistory);
  chrome.storage.local.set({ cookieHistory: historyObj }, () => {
    console.log('Cookie history saved:', cookieHistory.size, 'cookies');
  });
}

// Save cookie explanations to storage
function saveCookieExplanations() {
  const explanationsObj = Object.fromEntries(cookieExplanations);
  chrome.storage.local.set({ cookieExplanations: explanationsObj }, () => {
    console.log('Cookie explanations saved:', cookieExplanations.size, 'explanations');
  });
}

// Get AI explanation for cookie (with caching)
async function getAIExplanation(cookie) {
  const cookieKey = `${cookie.name}_${cookie.domain}`;
  
  // Check cache first
  if (cookieExplanations.has(cookieKey)) {
    console.log('Using cached explanation for:', cookie.name);
    return cookieExplanations.get(cookieKey);
  }
  
  try {
    const potentialData = cookie.potentialData || [];
    const dataTypesText = potentialData.length > 0 
      ? potentialData.join(', ') 
      : 'no specific data types detected';
    
    const prompt = `You are a privacy expert explaining cookies to non-technical users. Explain this cookie in 2-3 simple sentences:

Cookie Name: ${cookie.name}
Domain: ${cookie.domain}
Collects: ${dataTypesText}
Expires: ${cookie.expirationDate ? 'Long-term' : 'Session only'}

Explain:
1. What this cookie does in simple terms
2. Why the website uses it
3. Privacy concern (if any)

Keep it under 50 words, casual friendly tone.`;

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant', // Fast and free
        messages: [
          {
            role: 'system',
            content: 'You are a friendly privacy expert who explains technical concepts in simple, everyday language.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 150
      })
    });

    if (!response.ok) {
      throw new Error(`Groq API error: ${response.status}`);
    }

    const data = await response.json();
    const explanation = data.choices[0].message.content.trim();
    
    // Cache the explanation
    cookieExplanations.set(cookieKey, explanation);
    saveCookieExplanations();
    
    console.log('AI explanation generated for:', cookie.name);
    return explanation;
    
  } catch (error) {
    console.error('Error getting AI explanation:', error);
    
    // Fallback explanation
    const fallbackExplanations = {
      'session': 'This is a session cookie that helps the website remember you while you browse. It expires when you close your browser.',
      'tracking': 'This cookie tracks your browsing activity across pages. It helps the site understand how you use their service.',
      'analytics': 'This cookie collects statistics about how you use the website. Companies use this data to improve their site.',
      'advertising': 'This cookie is used to show you personalized ads based on your interests and browsing history.',
      'preference': 'This cookie remembers your settings and preferences so you don\'t have to set them every time.',
      'default': 'This cookie helps the website function properly. It may store information about your session or preferences.'
    };
    
    // Determine fallback type
    const name = cookie.name.toLowerCase();
    const potentialData = cookie.potentialData || [];
    
    if (name.includes('session') || name.includes('sid')) {
      return fallbackExplanations.session;
    } else if (potentialData.includes('marketing_data') || name.includes('ad')) {
      return fallbackExplanations.advertising;
    } else if (potentialData.includes('browsing_behavior') || name.includes('analytics')) {
      return fallbackExplanations.analytics;
    } else if (potentialData.includes('preferences') || name.includes('pref')) {
      return fallbackExplanations.preference;
    } else {
      return fallbackExplanations.default;
    }
  }
}

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
    const potentialData = detectPotentialData(changeInfo.cookie);
    const riskScore = await calculateRiskScore(changeInfo.cookie, potentialData);
    
    const cookieKey = `${changeInfo.cookie.name}_${changeInfo.cookie.domain}`;
    
    cookieHistory.set(cookieKey, {
      ...changeInfo.cookie,
      potentialData: potentialData,
      riskScore: riskScore,
      firstSeen: cookieHistory.has(cookieKey) ? cookieHistory.get(cookieKey).firstSeen : Date.now(),
      lastSeen: Date.now(),
      status: 'active'
    });
    
    saveCookieHistory();
    
    await analyzeCookie(changeInfo.cookie, potentialData, riskScore);
    
    const shouldBlock = await shouldBlockCookie(changeInfo.cookie);
    if (shouldBlock) {
      const historyEntry = cookieHistory.get(cookieKey);
      if (historyEntry) {
        historyEntry.status = 'blocked';
        historyEntry.blockedAt = Date.now();
        cookieHistory.set(cookieKey, historyEntry);
        saveCookieHistory();
      }
      
      await chrome.cookies.remove({
        url: getCookieUrl(changeInfo.cookie),
        name: changeInfo.cookie.name
      });
      console.log('Blocked cookie:', changeInfo.cookie.name);
    }
  } else {
    const cookieKey = `${changeInfo.cookie.name}_${changeInfo.cookie.domain}`;
    const historyEntry = cookieHistory.get(cookieKey);
    if (historyEntry && historyEntry.status === 'active') {
      historyEntry.status = 'removed';
      historyEntry.removedAt = Date.now();
      cookieHistory.set(cookieKey, historyEntry);
      saveCookieHistory();
    }
  }
  
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0 && tabs[0].url) {
    await updateCookieStats(tabs[0].url);
  }
});

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
      
    case 'GET_AI_EXPLANATION':
      getAIExplanation(message.cookie).then(explanation => {
        sendResponse({ explanation: explanation });
      });
      return true;
  }
});

async function analyzeCookie(cookie, potentialData, riskScore) {
  try {
    const settings = await chrome.storage.sync.get(['showNotifications']);
    
    if (riskScore >= 3 && settings.showNotifications !== false) {
      console.log(`Suspicious cookie detected: ${cookie.name} (Risk: ${riskScore})`);
      
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length > 0 && tabs[0].url && tabs[0].url.startsWith('http')) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'SUSPICIOUS_COOKIE',
          cookie: { ...cookie, potentialData: potentialData },
          riskScore: riskScore
        }).catch(error => {
          // Content script might not be ready
        });
      }
    }
  } catch (error) {
    console.log('Error analyzing cookie:', error);
  }
}

async function calculateRiskScore(cookie, potentialData) {
  let score = 0;
  
  const dataTypes = potentialData || detectPotentialData(cookie);
  score += dataTypes.length;
  
  const trackingPatterns = ['_ga', '_gid', '_fbp', 'fr', 'track', 'uid', 'analytics', 'ad', 'pixel'];
  const cookieStr = (cookie.name + cookie.value).toLowerCase();
  
  trackingPatterns.forEach(pattern => {
    if (cookieStr.includes(pattern)) score += 1;
  });
  
  try {
    if (activeTabDomain && !isSameDomain(cookie.domain, activeTabDomain)) {
      score += 2;
    }
  } catch (error) {
    console.log('Error checking cookie domain:', error);
  }
  
  if (cookie.expirationDate && cookie.expirationDate > (Date.now() / 1000) + 31536000) {
    score += 1;
  }
  
  if (!cookie.secure && cookie.domain && !cookie.domain.startsWith('http')) {
    score += 1;
  }
  
  console.log(`Cookie ${cookie.name}: ${dataTypes.length} data types, total score: ${score}`);
  
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
    
    const settings = await chrome.storage.sync.get(['autoBlockHighRisk']);
    
    for (const cookie of cookies) {
      const potentialData = detectPotentialData(cookie);
      const riskScore = await calculateRiskScore(cookie, potentialData);
      
      const cookieKey = `${cookie.name}_${cookie.domain}`;
      
      cookieHistory.set(cookieKey, {
        ...cookie,
        potentialData: potentialData,
        riskScore: riskScore,
        firstSeen: cookieHistory.has(cookieKey) ? cookieHistory.get(cookieKey).firstSeen : Date.now(),
        lastSeen: Date.now(),
        status: 'active'
      });
      
      await analyzeCookie(cookie, potentialData, riskScore);
      
      if (settings.autoBlockHighRisk) {
        if (riskScore >= 5) {
          const historyEntry = cookieHistory.get(cookieKey);
          if (historyEntry) {
            historyEntry.status = 'blocked';
            historyEntry.blockedAt = Date.now();
            historyEntry.autoBlocked = true;
            cookieHistory.set(cookieKey, historyEntry);
          }
          
          await chrome.cookies.remove({
            url: getCookieUrl(cookie),
            name: cookie.name
          });
          console.log('Auto-blocked high-risk cookie:', cookie.name);
          
          const permissionKey = `cookie_${cookie.name}_${cookie.domain}`;
          await chrome.storage.sync.set({
            [permissionKey]: {
              allowedDataTypes: [],
              action: 'block',
              timestamp: Date.now(),
              cookieName: cookie.name,
              cookieDomain: cookie.domain,
              autoBlocked: true,
              blocked: true,
              potentialData: potentialData
            }
          });
        }
      }
    }
    
    saveCookieHistory();
  } catch (error) {
    console.log('Error scanning cookies:', error);
  }
}

async function handleCookiePermissionsUpdate(cookie, allowedDataTypes, action) {
  console.log(`Cookie permission updated: ${cookie.name} - ${action}`, allowedDataTypes);
  
  const permissionKey = `cookie_${cookie.name}_${cookie.domain}`;
  const cookieKey = `${cookie.name}_${cookie.domain}`;
  
  const isBlocking = action === 'block' || (action === 'custom' && allowedDataTypes.length === 0);
  
  await chrome.storage.sync.set({
    [permissionKey]: {
      allowedDataTypes: allowedDataTypes,
      action: action,
      timestamp: Date.now(),
      cookieName: cookie.name,
      cookieDomain: cookie.domain,
      potentialData: cookie.potentialData || [],
      blocked: isBlocking
    }
  });
  
  const historyEntry = cookieHistory.get(cookieKey);
  if (historyEntry) {
    historyEntry.status = isBlocking ? 'blocked' : 'active';
    if (isBlocking) {
      historyEntry.blockedAt = Date.now();
    }
    historyEntry.userAction = action;
    historyEntry.allowedDataTypes = allowedDataTypes;
    cookieHistory.set(cookieKey, historyEntry);
    saveCookieHistory();
  }
  
  if (isBlocking) {
    try {
      await chrome.cookies.remove({
        url: getCookieUrl(cookie),
        name: cookie.name
      });
      console.log('Cookie blocked and removed:', cookie.name);
    } catch (error) {
      console.error('Error removing cookie:', error);
    }
  }
  
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
    const hostname = new URL(url).hostname;
    const cookies = await chrome.cookies.getAll({ url });
    const allPermissions = await chrome.storage.sync.get(null);
    
    let suspiciousCount = 0;
    let blockedCount = 0;
    let allowedCount = 0;
    
    const allCookieKeys = new Set();
    
    for (const cookie of cookies) {
      const cookieKey = `${cookie.name}_${cookie.domain}`;
      allCookieKeys.add(cookieKey);
      
      const potentialData = detectPotentialData(cookie);
      const riskScore = await calculateRiskScore(cookie, potentialData);
      
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
    
    for (const [cookieKey, historyEntry] of cookieHistory.entries()) {
      const cookieDomain = historyEntry.domain.replace(/^\./, '');
      if (hostname.includes(cookieDomain) || cookieDomain.includes(hostname)) {
        if (!allCookieKeys.has(cookieKey)) {
          allCookieKeys.add(cookieKey);
          
          if (historyEntry.riskScore >= 3) {
            suspiciousCount++;
          }
        }
        
        const permissionKey = `cookie_${historyEntry.name}_${historyEntry.domain}`;
        if (allPermissions[permissionKey] && allPermissions[permissionKey].blocked) {
          if (historyEntry.status !== 'blocked') {
            historyEntry.status = 'blocked';
          }
          blockedCount++;
        }
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
    
    chrome.runtime.sendMessage({
      type: 'STATS_UPDATED',
      stats: cookieStats
    }).catch(() => {});
    
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
    const hostname = new URL(url).hostname;
    const cookies = await chrome.cookies.getAll({ url });
    const allData = await chrome.storage.sync.get(null);
    
    const permissions = {};
    const settings = {};
    
    for (const [key, value] of Object.entries(allData)) {
      if (key.startsWith('cookie_')) {
        permissions[key] = value;
      } else {
        settings[key] = value;
      }
    }
    
    const analyzedCookies = [];
    const processedCookies = new Set();
    
    for (const cookie of cookies) {
      const cookieKey = `${cookie.name}_${cookie.domain}`;
      processedCookies.add(cookieKey);
      
      const historyEntry = cookieHistory.get(cookieKey);
      const potentialData = historyEntry ? historyEntry.potentialData : detectPotentialData(cookie);
      const riskScore = historyEntry ? historyEntry.riskScore : await calculateRiskScore(cookie, potentialData);
      
      let riskLevel = 'low';
      if (riskScore >= 5) riskLevel = 'high';
      else if (riskScore >= 3) riskLevel = 'medium';
      
      const permissionKey = `cookie_${cookie.name}_${cookie.domain}`;
      const permission = permissions[permissionKey] || null;
      
      // Get AI explanation (cached if available)
      const explanation = await getAIExplanation({
        ...cookie,
        potentialData: potentialData
      });
      
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
        status: permission && permission.blocked ? 'blocked' : 'active',
        firstSeen: historyEntry ? historyEntry.firstSeen : Date.now(),
        lastSeen: historyEntry ? historyEntry.lastSeen : Date.now(),
        aiExplanation: explanation
      });
    }
    
    for (const [cookieKey, historyEntry] of cookieHistory.entries()) {
      if (processedCookies.has(cookieKey)) continue;
      
      const cookieDomain = historyEntry.domain.replace(/^\./, '');
      if (hostname.includes(cookieDomain) || cookieDomain.includes(hostname)) {
        const permissionKey = `cookie_${historyEntry.name}_${historyEntry.domain}`;
        const permission = permissions[permissionKey] || null;
        
        let riskLevel = 'low';
        if (historyEntry.riskScore >= 5) riskLevel = 'high';
        else if (historyEntry.riskScore >= 3) riskLevel = 'medium';
        
        const explanation = await getAIExplanation(historyEntry);
        
        analyzedCookies.push({
          name: historyEntry.name,
          domain: historyEntry.domain,
          value: '[BLOCKED/REMOVED]',
          path: historyEntry.path || '/',
          secure: historyEntry.secure || false,
          httpOnly: historyEntry.httpOnly || false,
          sameSite: historyEntry.sameSite || 'unspecified',
          expirationDate: historyEntry.expirationDate,
          potentialData: historyEntry.potentialData || [],
          riskLevel: riskLevel,
          riskScore: historyEntry.riskScore || 0,
          permission: permission,
          status: historyEntry.status || 'removed',
          firstSeen: historyEntry.firstSeen,
          lastSeen: historyEntry.lastSeen,
          blockedAt: historyEntry.blockedAt,
          autoBlocked: historyEntry.autoBlocked,
          aiExplanation: explanation
        });
      }
    }
    
    return {
      exportDate: new Date().toISOString(),
      website: hostname,
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
  const cookieStr = (cookie.name + '=' + (cookie.value || '')).toLowerCase();
  
  const dataPatterns = {
    'email': ['email', 'mail', '@'],
    'name': ['name', 'user', 'username', 'fullname', 'firstname', 'lastname'],
    'location': ['location', 'geo', 'lat', 'long', 'gps', 'address', 'city', 'country', 'zip'],
    'device_info': ['device', 'os', 'browser', 'platform', 'useragent', 'screen', 'resolution', 'mobile'],
    'ip_address': ['ip', 'address', 'remoteaddr', 'clientip'],
    'browsing_behavior': ['behavior', 'click', 'scroll', 'movement', 'activity', 'history', 'visit', 'visitor'],
    'preferences': ['preference', 'setting', 'config', 'theme', 'language', 'currency', 'pref'],
    'session_data': ['session', 'login', 'token', 'auth', 'password', 'credential', 'sid'],
    'marketing_data': ['ad', 'marketing', 'campaign', 'tracking', 'analytics', 'conversion'],
    'social_media_data': ['social', 'facebook', 'twitter', 'linkedin', 'instagram', 'google', 'youtube'],
    'shopping_data': ['cart', 'basket', 'purchase', 'product', 'item', 'price'],
    'demographic_data': ['age', 'gender', 'birth', 'income', 'education', 'demographic']
  };
  
  for (const [dataType, patterns] of Object.entries(dataPatterns)) {
    if (patterns.some(pattern => cookieStr.includes(pattern))) {
      dataTypes.push(dataType);
    }
  }
  
  return [...new Set(dataTypes)];
}

chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
  if (tabs.length > 0 && tabs[0].url && tabs[0].url.startsWith('http')) {
    activeTabDomain = new URL(tabs[0].url).hostname;
    console.log('Initial active domain:', activeTabDomain);
    await updateCookieStats(tabs[0].url);
  }
});
