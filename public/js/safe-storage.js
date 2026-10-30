/**
 * Direct Beam SafeStorage
 * Resilient, zero-throw storage layer for Incognito mode, Private Browsing,
 * in-app WebViews (Snapchat, Instagram, Telegram), and restricted iframe contexts
 * where accessing `window.localStorage` throws a SecurityError:
 * "Failed to read the 'localStorage' property from 'Window': Access is denied for this document."
 */
(function(window) {
  'use strict';

  var memoryStore = {};

  // Check if cookies are available as secondary persistence fallback
  function getCookie(name) {
    try {
      if (typeof document === 'undefined' || !document.cookie) return null;
      var match = document.cookie.match(new RegExp('(^|;\\s*)' + encodeURIComponent(name) + '=([^;]*)'));
      return match ? decodeURIComponent(match[2]) : null;
    } catch (e) {
      return null;
    }
  }

  function setCookie(name, value, days) {
    try {
      if (typeof document === 'undefined') return;
      var expires = '';
      if (days) {
        var d = new Date();
        d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = '; expires=' + d.toUTCString();
      }
      document.cookie = encodeURIComponent(name) + '=' + encodeURIComponent(value) + expires + '; path=/; SameSite=Lax';
    } catch (e) {}
  }

  function removeCookie(name) {
    try {
      if (typeof document === 'undefined') return;
      document.cookie = encodeURIComponent(name) + '=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax';
    } catch (e) {}
  }

  // Probe localStorage availability safely
  var isLocalStorageSupported = (function() {
    try {
      if (typeof window === 'undefined') return false;
      var testKey = '__db_probe_storage__';
      window.localStorage.setItem(testKey, '1');
      window.localStorage.removeItem(testKey);
      return true;
    } catch (e) {
      return false;
    }
  })();

  var safeStorage = {
    isSupported: isLocalStorageSupported,

    getItem: function(key) {
      if (isLocalStorageSupported) {
        try {
          var val = window.localStorage.getItem(key);
          if (val !== null) return val;
        } catch (e) {}
      }
      if (Object.prototype.hasOwnProperty.call(memoryStore, key)) {
        return memoryStore[key];
      }
      var cookieVal = getCookie(key);
      if (cookieVal !== null) {
        memoryStore[key] = cookieVal;
        return cookieVal;
      }
      return null;
    },

    setItem: function(key, val) {
      var strVal = String(val);
      memoryStore[key] = strVal;
      if (isLocalStorageSupported) {
        try {
          window.localStorage.setItem(key, strVal);
        } catch (e) {}
      }
      // Keep lightweight cookies as fallback (exclude large blobs)
      if (strVal.length < 3500) {
        setCookie(key, strVal, 30);
      }
    },

    removeItem: function(key) {
      delete memoryStore[key];
      if (isLocalStorageSupported) {
        try {
          window.localStorage.removeItem(key);
        } catch (e) {}
      }
      removeCookie(key);
    },

    clear: function() {
      memoryStore = {};
      if (isLocalStorageSupported) {
        try {
          window.localStorage.clear();
        } catch (e) {}
      }
    }
  };

  // Expose as global safeStorage
  window.safeStorage = safeStorage;

  // Try to safely replace or define window.localStorage if it throws or is undefined
  try {
    if (!isLocalStorageSupported) {
      Object.defineProperty(window, 'localStorage', {
        value: safeStorage,
        configurable: true,
        enumerable: true,
        writable: true
      });
    }
  } catch (e) {
    // If browser prevents redefining window.localStorage, safeStorage remains directly accessible
  }
})(typeof window !== 'undefined' ? window : globalThis);
