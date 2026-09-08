/**
 * Persistent calendar-rate cache (IndexedDB).
 * Entries older than TTL_MS are treated as stale and refreshed on next use.
 */

const DB_NAME = "go-rates-cache";
const DB_VERSION = 2;
const STORE = "calendars";
const ROOM_STORE = "shopRooms";
const TTL_MS = 24 * 60 * 60 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("fetchedAt", "fetchedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(ROOM_STORE)) {
        const store = db.createObjectStore(ROOM_STORE, { keyPath: "key" });
        store.createIndex("fetchedAt", "fetchedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function calendarCacheKey({ ctyhocn, arrivalDate, nights, friendsAndFamily, guestId, currency = "USD" }) {
  return [
    String(ctyhocn || "").toUpperCase(),
    arrivalDate,
    String(nights || 1),
    friendsAndFamily ? "fnf" : "tm",
    guestId ? String(guestId) : "0",
    "usd-fx",
  ].join("|");
}

async function getCachedCalendar(params) {
  const key = calendarCacheKey(params);
  const db = await openDb();
  try {
    const entry = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!entry?.calendar) return null;
    const age = Date.now() - Number(entry.fetchedAt || 0);
    if (age > TTL_MS) return null;
    return {
      ...entry.calendar,
      cached: true,
      fetchedAt: entry.fetchedAt,
      ageMs: age,
    };
  } finally {
    db.close();
  }
}

async function setCachedCalendar(params, calendar) {
  const key = calendarCacheKey(params);
  const db = await openDb();
  try {
    const record = {
      key,
      ctyhocn: String(params.ctyhocn || "").toUpperCase(),
      arrivalDate: params.arrivalDate,
      nights: Number(params.nights || 1),
      friendsAndFamily: Boolean(params.friendsAndFamily),
      guestId: params.guestId || null,
      fetchedAt: Date.now(),
      calendar: {
        ctyhocn: calendar.ctyhocn,
        currency: calendar.currency,
        statusCode: calendar.statusCode,
        days: calendar.days || [],
      },
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).put(record);
    });
  } finally {
    db.close();
  }
}

async function pruneStaleCache() {
  const cutoff = Date.now() - TTL_MS;
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, ROOM_STORE], "readwrite");
      for (const name of [STORE, ROOM_STORE]) {
        const store = tx.objectStore(name);
        const index = store.index("fetchedAt");
        const range = IDBKeyRange.upperBound(cutoff);
        const req = index.openCursor(range);
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function shopRoomsCacheKey({
  ctyhocn,
  arrivalDate,
  departureDate,
  friendsAndFamily,
  guestId,
  currency = "USD",
}) {
  return [
    String(ctyhocn || "").toUpperCase(),
    arrivalDate,
    departureDate,
    friendsAndFamily ? "fnf" : "tm",
    guestId ? String(guestId) : "0",
    "usd-fx-rt3",
  ].join("|");
}

async function getCachedShopRooms(params) {
  const key = shopRoomsCacheKey(params);
  const db = await openDb();
  try {
    const entry = await new Promise((resolve, reject) => {
      const tx = db.transaction(ROOM_STORE, "readonly");
      const req = tx.objectStore(ROOM_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!entry?.payload) return null;
    const age = Date.now() - Number(entry.fetchedAt || 0);
    if (age > TTL_MS) return null;
    return { ...entry.payload, cached: true, fetchedAt: entry.fetchedAt };
  } finally {
    db.close();
  }
}

async function setCachedShopRooms(params, payload) {
  const key = shopRoomsCacheKey(params);
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(ROOM_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(ROOM_STORE).put({
        key,
        fetchedAt: Date.now(),
        payload: {
          ctyhocn: payload.ctyhocn,
          currency: payload.currency,
          statusCode: payload.statusCode,
          rooms: payload.rooms || [],
        },
      });
    });
  } finally {
    db.close();
  }
}

async function deleteCachedCalendar(params) {
  const key = calendarCacheKey(params);
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).delete(key);
    });
  } finally {
    db.close();
  }
}

async function deleteCachedShopRooms(params) {
  const key = shopRoomsCacheKey(params);
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(ROOM_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(ROOM_STORE).delete(key);
    });
  } finally {
    db.close();
  }
}

async function getCacheStats() {
  const db = await openDb();
  try {
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const now = Date.now();
    let fresh = 0;
    let stale = 0;
    for (const entry of all) {
      if (now - Number(entry.fetchedAt || 0) > TTL_MS) stale += 1;
      else fresh += 1;
    }
    return { total: all.length, fresh, stale, ttlHours: TTL_MS / 3600000 };
  } finally {
    db.close();
  }
}

export {
  TTL_MS,
  getCachedCalendar,
  setCachedCalendar,
  deleteCachedCalendar,
  getCachedShopRooms,
  setCachedShopRooms,
  deleteCachedShopRooms,
  pruneStaleCache,
  getCacheStats,
  calendarCacheKey,
};
