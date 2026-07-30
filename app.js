// ====== מזג ודעה — Phase 2: התחברות + פיד לקריאה בלבד ======
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, collection, query, orderBy, limit, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

// ⚠️ תחליף בערכים האמיתיים שלך מ-Project settings → Your apps (שלב 5 בהוראות)
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// תגיות שמדליקות את הפס הכתום (אזהרה/התרעה) על כרטיס העדכון
const SEVERE_TAGS = ["התרעה", "אזהרה", "חירום", "סופה", "שיטפון"];

let me = null;
let unsubscribeFeed = null;

// ===== DOM =====
const $ = (id) => document.getElementById(id);

// ===== עזרי טקסט (בטוחים מפני HTML) =====
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

  // בדיקת חסימה מול settings/site
  let blocked = false;
  try {
    const settingsSnap = await getDoc(doc(db, "settings", "site"));
    const blockedEmails = settingsSnap.exists() ? settingsSnap.data().blockedEmails || [] : [];
    blocked = blockedEmails.includes(me.email);
  } catch (e) {
    console.error("שגיאה בבדיקת חסימה:", e);
  }

  if (blocked) {
    show("bannedScreen");
    return;
  }

  show("app");
  $("hdrUserName").textContent = me.name;
  const av = $("userAvatar");
  av.innerHTML = me.picture
    ? `<img src="${me.picture}" onclick="window._doLogout()" title="התנתק">`
    : `<div style="width:32px;height:32px;border-radius:50%;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;cursor:pointer" onclick="window._doLogout()">${esc(me.name[0].toUpperCase())}</div>`;

  startFeed();
});

function show(id) {
  ["loginScreen", "bannedScreen", "app"].forEach((s) => {
    const el = $(s);
    if (!el) return;
    el.style.display = s === id ? (s === "app" ? "flex" : "flex") : "none";
  });
}

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
  return `
    <div class="post-card${isSevere ? " severe" : ""}" data-id="${id}">
      <div class="post-meta">
        <span class="post-sender">${esc(p.authorName || "מזג ודעה")}</span>
        <span class="post-time">${fmtTime(p.createdAt)}</span>
        ${isSevere ? '<span class="severe-badge"><i class="fas fa-triangle-exclamation"></i> התרעה</span>' : ""}
      </div>
      <div class="post-text">${rich(p.text || "")}</div>
      ${media}
      ${tags}
    </div>`;
}
