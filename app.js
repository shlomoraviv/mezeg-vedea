// ====== מזג ודעה — Phase 3: התחברות + פיד + פרסום + תגובות + ריאקציות + ניהול ======
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc,
  arrayUnion, arrayRemove, serverTimestamp,
  collection, query, orderBy, limit, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
// Phase 4: הודעות מנהל, לוח מובילים, מצב תחזוקה, פרסומת

const firebaseConfig = {
  apiKey: "AIzaSyDTTv6qEjKoKa2ObdpQR-whFdR3QUl6fqQ",
  authDomain: "mezeg-vedea.firebaseapp.com",
  projectId: "mezeg-vedea",
  storageBucket: "mezeg-vedea.firebasestorage.app",
  messagingSenderId: "873563607640",
  appId: "1:873563607640:web:da3e6cc1749c3bca96f02d",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const SEVERE_TAGS = ["התרעה", "אזהרה", "חירום", "סופה", "שיטפון"];
const REACTIONS = ["👍", "❤️", "😮", "😢", "🔥"];

let me = null;          // {email, name, picture}
let myRole = "reader";  // 'super' | 'writer' | 'reader'
let unsubscribeFeed = null;
let unsubscribeComments = {}; // postId -> unsubscribe fn
let unsubscribeSettings = null;
let unsubscribeAnnouncements = null;
let siteSettings = {}; // updateMode, ad
let lastFeedPosts = []; // used for leaderboard aggregation

const $ = (id) => document.getElementById(id);

// ===== עזרי טקסט =====
function esc(t) {
  return (t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function rich(t) {
  if (!t) return "";
  let s = esc(t).replace(/\n/g, "<br>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/_([^_\n]+)_/g, "<em>$1</em>");
  return s;
}
function fmtTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function youTubeEmbedUrl(url) {
  const m = (url || "").match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? `https://www.youtube.com/embed/${m[1]}` : null;
}

// ===== כניסה / יציאה =====
window._doLogin = async function () {
  $("loginError").textContent = "";
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    $("loginError").textContent = "ההתחברות נכשלה, נסה שוב.";
    console.error(e);
  }
};
window._doLogout = async function () {
  if (unsubscribeFeed) unsubscribeFeed();
  Object.values(unsubscribeComments).forEach((fn) => fn && fn());
  unsubscribeComments = {};
  if (unsubscribeSettings) unsubscribeSettings();
  if (unsubscribeAnnouncements) unsubscribeAnnouncements();
  await signOut(auth);
};

// ===== מצב התחברות =====
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    me = null;
    show("loginScreen");
    return;
  }

  me = { email: user.email.toLowerCase(), name: user.displayName || user.email, picture: user.photoURL || "" };

  // בדיקת חסימה + הגדרות אתר (מצב תחזוקה, פרסומת)
  let blocked = false;
  try {
    const settingsSnap = await getDoc(doc(db, "settings", "site"));
    siteSettings = settingsSnap.exists() ? settingsSnap.data() : {};
    const blockedEmails = siteSettings.blockedEmails || [];
    blocked = blockedEmails.includes(me.email);
  } catch (e) {
    console.error("שגיאה בבדיקת חסימה:", e);
  }

  if (blocked) {
    show("bannedScreen");
    return;
  }

  try {
    const roleSnap = await getDoc(doc(db, "roles", me.email));
    myRole = roleSnap.exists() ? roleSnap.data().role || "reader" : "reader";
  } catch (e) {
    myRole = "reader";
  }

  // מצב תחזוקה — כולם חוץ ממנהל-על רואים מסך תחזוקה
  if (siteSettings.updateMode && siteSettings.updateMode.enabled && myRole !== "super") {
    $("maintenanceMsg").textContent = siteSettings.updateMode.message || "האתר בתחזוקה זמנית, נחזור בקרוב.";
    show("maintenanceScreen");
    return;
  }

  show("app");
  $("hdrUserName").textContent = me.name;
  const av = $("userAvatar");
  av.innerHTML = me.picture
    ? `<img src="${me.picture}" onclick="window._doLogout()" title="התנתק">`
    : `<div style="width:32px;height:32px;border-radius:50%;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;cursor:pointer" onclick="window._doLogout()">${esc(me.name[0].toUpperCase())}</div>`;

  // כותבים ומנהלים רואים טופס פרסום
  $("composer").style.display = (myRole === "writer" || myRole === "super") ? "block" : "none";
  // מנהלי-על רואים כפתור ניהול
  $("adminBtn").style.display = myRole === "super" ? "flex" : "none";
  // הודעות מנהל ולוח מובילים גלויים לכולם
  $("announceBtn").style.display = "flex";
  $("leaderboardBtn").style.display = "flex";

  renderAdBanner();
  startAnnouncements();
  startFeed();
});

// ===== באנר פרסומת =====
function renderAdBanner() {
  const holder = $("adBanner");
  const ad = siteSettings.ad;
  if (!ad || !ad.enabled || (!ad.text && !ad.imgUrl)) {
    holder.style.display = "none";
    holder.innerHTML = "";
    return;
  }
  const inner = `
    ${ad.imgUrl ? `<img src="${esc(ad.imgUrl)}" alt="">` : ""}
    ${ad.text ? `<span>${esc(ad.text)}</span>` : ""}
  `;
  holder.innerHTML = ad.linkUrl
    ? `<a href="${esc(ad.linkUrl)}" target="_blank" rel="noopener">${inner}</a>`
    : inner;
  holder.style.display = "flex";
}

// ===== הודעות מנהל =====
function startAnnouncements() {
  if (unsubscribeAnnouncements) unsubscribeAnnouncements();
  const q = query(collection(db, "announcements"), orderBy("createdAt", "desc"), limit(30));
  unsubscribeAnnouncements = onSnapshot(q, (snap) => {
    const badge = $("announceBadge");
    if (badge) badge.style.display = snap.empty ? "none" : "inline-block";
    const list = $("announceList");
    if (!list) return;
    if (snap.empty) {
      list.innerHTML = `<p class="admin-empty">אין הודעות עדיין.</p>`;
      return;
    }
    list.innerHTML = snap.docs.map((d) => {
      const a = d.data();
      const canDel = myRole === "super" || a.authorEmail === (me && me.email);
      return `
        <div class="announce-row">
          <div class="announce-body">
            <span class="announce-author">${esc(a.authorName || "מנהל")} · ${fmtTime(a.createdAt)}</span>
            <span class="announce-text">${rich(a.text || "")}</span>
          </div>
          ${canDel ? `<button class="cmt-del" onclick="window._deleteAnnouncement('${d.id}')" title="מחק">✕</button>` : ""}
        </div>`;
    }).join("");
  });
}

window._openAnnouncements = function () {
  $("announceModal").style.display = "flex";
  $("announceSendRow").style.display = (myRole === "writer" || myRole === "super") ? "flex" : "none";
};
window._closeAnnouncements = function () {
  $("announceModal").style.display = "none";
};
window._sendAnnouncement = async function () {
  const input = $("announceInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try {
    await addDoc(collection(db, "announcements"), {
      text, authorEmail: me.email, authorName: me.name, createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.error(e);
    alert("השליחה נכשלה.");
  }
};
window._deleteAnnouncement = async function (id) {
  try {
    await deleteDoc(doc(db, "announcements", id));
  } catch (e) {
    console.error(e);
  }
};

// ===== לוח מובילים (מבוסס על 20 העדכונים האחרונים שנטענו) =====
window._openLeaderboard = function () {
  $("leaderboardModal").style.display = "flex";
  const counts = {}; // email -> {name, posts, reactions}
  lastFeedPosts.forEach((p) => {
    const email = p.authorEmail || "unknown";
    if (!counts[email]) counts[email] = { name: p.authorName || email, posts: 0, reactions: 0 };
    counts[email].posts += 1;
    const rx = p.reactions || {};
    Object.values(rx).forEach((arr) => { counts[email].reactions += (arr || []).length; });
  });
  const rows = Object.values(counts).sort((a, b) => (b.posts + b.reactions) - (a.posts + a.reactions));
  const list = $("leaderboardList");
  list.innerHTML = rows.length
    ? rows.map((r, i) => `
        <div class="admin-row">
          <span>#${i + 1} ${esc(r.name)}</span>
          <span>${r.posts} פוסטים · ${r.reactions} ריאקציות</span>
        </div>`).join("")
    : `<p class="admin-empty">אין עדיין נתונים.</p>`;
};
window._closeLeaderboard = function () {
  $("leaderboardModal").style.display = "none";
};

// ===== הגדרות אתר (מצב תחזוקה + פרסומת) — מנהל-על בלבד =====
window._saveUpdateMode = async function () {
  const enabled = $("updateModeToggle").checked;
  const message = $("updateModeMsg").value.trim();
  try {
    await setDoc(doc(db, "settings", "site"), { updateMode: { enabled, message } }, { merge: true });
    $("settingsMsg").textContent = "נשמר.";
  } catch (e) {
    console.error(e);
    $("settingsMsg").textContent = "השמירה נכשלה.";
  }
};
window._saveAd = async function () {
  const enabled = $("adToggle").checked;
  const text = $("adText").value.trim();
  const imgUrl = $("adImg").value.trim();
  const linkUrl = $("adLink").value.trim();
  try {
    await setDoc(doc(db, "settings", "site"), { ad: { enabled, text, imgUrl, linkUrl } }, { merge: true });
    $("settingsMsg").textContent = "נשמר.";
  } catch (e) {
    console.error(e);
    $("settingsMsg").textContent = "השמירה נכשלה.";
  }
};

function show(id) {
  ["loginScreen", "bannedScreen", "maintenanceScreen", "app"].forEach((s) => {
    const el = $(s);
    if (!el) return;
    el.style.display = s === id ? (s === "app" ? "flex" : "flex") : "none";
  });
}

// ===== פרסום פוסט חדש =====
window._submitPost = async function () {
  const text = $("composerText").value.trim();
  const imgUrl = $("composerImg").value.trim();
  const videoUrl = $("composerVideo").value.trim();
  const tagsRaw = $("composerTags").value.trim();
  const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const errEl = $("composerError");
  errEl.textContent = "";

  if (!text && !imgUrl && !videoUrl) {
    errEl.textContent = "צריך לכתוב טקסט, או להוסיף תמונה/וידאו.";
    return;
  }

  const btn = $("composerSubmitBtn");
  btn.disabled = true;
  try {
    await addDoc(collection(db, "posts"), {
      text, imgUrl, videoUrl, tags,
      authorEmail: me.email,
      authorName: me.name,
      createdAt: serverTimestamp(),
      reactions: {},
    });
    $("composerText").value = "";
    $("composerImg").value = "";
    $("composerVideo").value = "";
    $("composerTags").value = "";
  } catch (e) {
    console.error(e);
    errEl.textContent = "הפרסום נכשל, נסה שוב.";
  } finally {
    btn.disabled = false;
  }
};

// ===== מחיקת פוסט =====
window._deletePost = async function (id) {
  if (!confirm("למחוק את העדכון הזה?")) return;
  try {
    await deleteDoc(doc(db, "posts", id));
  } catch (e) {
    console.error(e);
    alert("המחיקה נכשלה.");
  }
};

// ===== ריאקציות =====
window._toggleReaction = async function (postId, emoji, alreadyReacted) {
  const field = `reactions.${emoji}`;
  try {
    await updateDoc(doc(db, "posts", postId), {
      [field]: alreadyReacted ? arrayRemove(me.email) : arrayUnion(me.email),
    });
  } catch (e) {
    console.error(e);
  }
};

// ===== תגובות =====
window._toggleComments = function (postId) {
  const panel = $(`cmt-panel-${postId}`);
  if (!panel) return;
  const isOpen = panel.style.display === "block";
  if (isOpen) {
    panel.style.display = "none";
    if (unsubscribeComments[postId]) {
      unsubscribeComments[postId]();
      delete unsubscribeComments[postId];
    }
    return;
  }
  panel.style.display = "block";
  const q = query(collection(db, "posts", postId, "comments"), orderBy("createdAt", "asc"));
  unsubscribeComments[postId] = onSnapshot(q, (snap) => {
    const list = $(`cmt-list-${postId}`);
    if (!list) return;
    list.innerHTML = snap.docs.map((d) => buildComment(postId, d.id, d.data())).join("");
  });
};

function buildComment(postId, id, c) {
  const canDelete = me && (myRole === "super" || c.authorEmail === me.email);
  return `
    <div class="cmt-row">
      <div class="cmt-body">
        <span class="cmt-author">${esc(c.authorName || "אנונימי")}</span>
        <span class="cmt-text">${esc(c.text || "")}</span>
      </div>
      ${canDelete ? `<button class="cmt-del" onclick="window._deleteComment('${postId}','${id}')" title="מחק">✕</button>` : ""}
    </div>`;
}

window._sendComment = async function (postId) {
  const input = $(`cmt-input-${postId}`);
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try {
    await addDoc(collection(db, "posts", postId, "comments"), {
      text,
      authorEmail: me.email,
      authorName: me.name,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.error(e);
  }
};

window._deleteComment = async function (postId, commentId) {
  try {
    await deleteDoc(doc(db, "posts", postId, "comments", commentId));
  } catch (e) {
    console.error(e);
  }
};

// ===== פאנל ניהול =====
window._openAdmin = function () {
  $("adminModal").style.display = "flex";
  const settingsRef = doc(db, "settings", "site");
  unsubscribeSettings = onSnapshot(settingsRef, (snap) => {
    const data = snap.exists() ? snap.data() : {};
    siteSettings = data;
    const blocked = data.blockedEmails || [];
    $("blockedList").innerHTML = blocked.length
      ? blocked.map((em) => `
          <div class="admin-row">
            <span>${esc(em)}</span>
            <button onclick="window._unblockUser('${esc(em)}')">בטל חסימה</button>
          </div>`).join("")
      : `<p class="admin-empty">אין משתמשים חסומים.</p>`;

    const um = data.updateMode || {};
    $("updateModeToggle").checked = !!um.enabled;
    $("updateModeMsg").value = um.message || "";

    const ad = data.ad || {};
    $("adToggle").checked = !!ad.enabled;
    $("adText").value = ad.text || "";
    $("adImg").value = ad.imgUrl || "";
    $("adLink").value = ad.linkUrl || "";
  });
};
window._closeAdmin = function () {
  $("adminModal").style.display = "none";
  if (unsubscribeSettings) { unsubscribeSettings(); unsubscribeSettings = null; }
};

window._blockUser = async function () {
  const email = $("blockEmailInput").value.trim().toLowerCase();
  if (!email) return;
  try {
    await setDoc(doc(db, "settings", "site"), { blockedEmails: arrayUnion(email) }, { merge: true });
    $("blockEmailInput").value = "";
  } catch (e) {
    console.error(e);
    alert("החסימה נכשלה.");
  }
};
window._unblockUser = async function (email) {
  try {
    await updateDoc(doc(db, "settings", "site"), { blockedEmails: arrayRemove(email) });
  } catch (e) {
    console.error(e);
  }
};

window._setRole = async function () {
  const email = $("roleEmailInput").value.trim().toLowerCase();
  const role = $("roleSelect").value;
  const name = $("roleNameInput").value.trim() || email;
  const msgEl = $("roleMsg");
  msgEl.textContent = "";
  if (!email) { msgEl.textContent = "צריך למלא אימייל."; return; }
  try {
    await setDoc(doc(db, "roles", email), { role, name }, { merge: true });
    msgEl.textContent = `עודכן: ${email} → ${role}`;
    $("roleEmailInput").value = "";
    $("roleNameInput").value = "";
  } catch (e) {
    console.error(e);
    msgEl.textContent = "העדכון נכשל.";
  }
};

// ===== פיד בזמן אמת =====
function startFeed() {
  if (unsubscribeFeed) unsubscribeFeed();
  const q = query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(20));
  unsubscribeFeed = onSnapshot(
    q,
    (snap) => {
      const inner = $("feedInner");
      const empty = $("empty");
      if (snap.empty) {
        inner.innerHTML = "";
        empty.style.display = "block";
        return;
      }
      empty.style.display = "none";
      lastFeedPosts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      inner.innerHTML = snap.docs.map((d) => buildPostCard(d.id, d.data())).join("");
    },
    (err) => {
      console.error("שגיאת פיד:", err);
    }
  );
}

function buildPostCard(id, p) {
  const isSevere = (p.tags || []).some((t) => SEVERE_TAGS.includes(t));
  let media = "";
  if (p.imgUrl) {
    media += `<div class="post-img"><img src="${esc(p.imgUrl)}" loading="lazy"></div>`;
  }
  const yt = youTubeEmbedUrl(p.videoUrl);
  if (yt) {
    media += `<div class="post-vid"><iframe src="${yt}" allowfullscreen></iframe></div>`;
  }
  let tags = "";
  if (p.tags && p.tags.length) {
    tags = `<div class="post-tags">${p.tags.map((t) => `<span class="post-tag">#${esc(t)}</span>`).join("")}</div>`;
  }

  const reactions = p.reactions || {};
  const reactionBar = REACTIONS.map((emoji) => {
    const emails = reactions[emoji] || [];
    const mine = me && emails.includes(me.email);
    return `<button class="rxn-btn${mine ? " mine" : ""}" onclick="window._toggleReaction('${id}','${emoji}',${mine})">
      ${emoji} <span class="rxn-count">${emails.length || ""}</span>
    </button>`;
  }).join("");

  const canDelete = myRole === "writer" || myRole === "super";
  const deleteBtn = canDelete
    ? `<button class="post-del" onclick="window._deletePost('${id}')" title="מחק עדכון"><i class="fas fa-trash"></i></button>`
    : "";

  return `
    <div class="post-card${isSevere ? " severe" : ""}" data-id="${id}">
      <div class="post-meta">
        <span class="post-sender">${esc(p.authorName || "מזג ודעה")}</span>
        <span class="post-time">${fmtTime(p.createdAt)}</span>
        ${isSevere ? '<span class="severe-badge"><i class="fas fa-triangle-exclamation"></i> התרעה</span>' : ""}
        ${deleteBtn}
      </div>
      <div class="post-text">${rich(p.text || "")}</div>
      ${media}
      ${tags}
      <div class="post-actions">
        <div class="rxn-bar">${reactionBar}</div>
        <button class="cmt-toggle" onclick="window._toggleComments('${id}')"><i class="fas fa-comment"></i> תגובות</button>
      </div>
      <div class="cmt-panel" id="cmt-panel-${id}">
        <div class="cmt-list" id="cmt-list-${id}"></div>
        <div class="cmt-input-row">
          <input type="text" id="cmt-input-${id}" placeholder="כתוב תגובה..." maxlength="500"
                 onkeydown="if(event.key==='Enter')window._sendComment('${id}')">
          <button onclick="window._sendComment('${id}')"><i class="fas fa-paper-plane"></i></button>
        </div>
      </div>
    </div>`;
}
