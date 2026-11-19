(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const storageKeys = {
    reviews: "adk_reviews",
    stats: "adk_stats",
    miniDone: "adk_mini_done",
    certificate: "adk_certificate"
  };
  const miniLessons = [
    {
      id: "nominal",
      title: "جملهٔ اسمیه",
      text: "جملهٔ اسمیه معمولاً با اسم آغاز می‌شود: «البيتُ كبيرٌ»؛ خانه بزرگ است.",
      question: "«البيتُ» در این جمله چه نقشی دارد؟",
      options: ["مبتدا", "خبر", "فعل"],
      answer: 0
    },
    {
      id: "verbal",
      title: "جملهٔ فعلیه",
      text: "جملهٔ فعلیه با فعل آغاز می‌شود: «كتبَ الطالبُ»؛ دانش‌آموز نوشت.",
      question: "کدام واژه فعل است؟",
      options: ["كتبَ", "الطالبُ", "هیچ‌کدام"],
      answer: 0
    },
    {
      id: "preposition",
      title: "حرف جر",
      text: "اسم پس از حرف جر مجرور می‌شود: «في البيتِ»؛ در خانه.",
      question: "اعراب «البيتِ» در این عبارت چیست؟",
      options: ["مجرور", "مرفوع", "منصوب"],
      answer: 0
    }
  ];
  const reviewIntervals = [1, 3, 7, 14, 30];
  const deviceId = getDeviceId();
  let reviewQueue = readJson(storageKeys.reviews, []);
  let migratedReviews = false;
  readJson("adk_missed", []).forEach(item => {
    const splitAt = item.lastIndexOf(" ← ");
    if (splitAt < 1) return;
    const prompt = item.slice(0, splitAt);
    const answer = item.slice(splitAt + 3);
    if (reviewQueue.some(card => card.prompt === prompt && card.answer === answer)) return;
    reviewQueue.push({
      prompt,
      answer,
      dueAt: new Date(0).toISOString(),
      intervalDays: 1,
      repetitions: 0,
      updatedAt: new Date().toISOString()
    });
    migratedReviews = true;
  });
  let stats = normalizeStats(readJson(storageKeys.stats, { answered: 0, correct: 0, days: {} }));
  let miniDone = readJson(storageKeys.miniDone, []);
  let questionNumber = 0;
  let reviewFilter = "due";
  let supabase = null;
  let currentUser = null;
  let isAdmin = false;
  let syncTimer = 0;
  let applyingCloudState = false;
  let syncPromise = null;
  let syncRequested = false;
  let coursesCache = [];
  let lessonsCache = [];
  let enrolledCourseIds = new Set();
  let editingCourseId = null;
  let editingLessonId = null;

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      console.error(`خواندن ${key} از ذخیره‌سازی محلی ناموفق بود.`, error);
      return fallback;
    }
  }

  function getDeviceId() {
    let id = localStorage.getItem("adk_device_id");
    if (!id) {
      id = globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem("adk_device_id", id);
    }
    return id;
  }

  function normalizeStats(value) {
    const source = value && typeof value === "object" ? value : {};
    const devices = source.devices && typeof source.devices === "object"
      ? JSON.parse(JSON.stringify(source.devices))
      : {
          legacy: {
            answered: Number(source.answered) || 0,
            correct: Number(source.correct) || 0,
            days: source.days && typeof source.days === "object" ? source.days : {}
          }
        };
    const totals = { answered: 0, correct: 0, days: {} };
    Object.values(devices).forEach(bucket => {
      totals.answered += Number(bucket.answered) || 0;
      totals.correct += Number(bucket.correct) || 0;
      Object.entries(bucket.days || {}).forEach(([date, count]) => {
        totals.days[date] = (totals.days[date] || 0) + (Number(count) || 0);
      });
    });
    return { ...totals, devices };
  }

  function mergeStats(first, second) {
    const devices = {};
    [first, second].forEach(value => {
      const source = normalizeStats(value).devices;
      Object.entries(source).forEach(([id, bucket]) => {
        const previous = devices[id] || { answered: 0, correct: 0, days: {} };
        const days = { ...previous.days };
        Object.entries(bucket.days || {}).forEach(([date, count]) => {
          days[date] = Math.max(Number(days[date]) || 0, Number(count) || 0);
        });
        devices[id] = {
          answered: Math.max(Number(previous.answered) || 0, Number(bucket.answered) || 0),
          correct: Math.max(Number(previous.correct) || 0, Number(bucket.correct) || 0),
          days
        };
      });
    });
    return normalizeStats({ devices });
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error(`ذخیرهٔ ${key} ناموفق بود.`, error);
      setStatus($("#account-status"), "ذخیرهٔ محلی انجام نشد؛ فضای مرورگر یا مجوز ذخیره‌سازی را بررسی کن.", "error");
      return false;
    }
  }

  function setStatus(element, message, kind = "") {
    if (!element) return;
    element.textContent = message;
    element.className = `status${kind ? ` ${kind}` : ""}`;
  }

  function localState() {
    return {
      done: Number(localStorage.getItem("adk_done")) || 0,
      unlocked: Number(localStorage.getItem("adk_unl")) || 1,
      xp: Number(localStorage.getItem("adk_xp")) || 0,
      examDone: localStorage.getItem("adk_examDone") === "true",
      missed: readJson("adk_missed", []),
      reviews: reviewQueue,
      stats,
      miniDone,
      updatedAt: localStorage.getItem("adk_state_updated") || "1970-01-01T00:00:00.000Z"
    };
  }

  function saveState(state) {
    localStorage.setItem("adk_done", Number(state.done) || 0);
    localStorage.setItem("adk_unl", Number(state.unlocked) || 1);
    localStorage.setItem("adk_xp", Number(state.xp) || 0);
    localStorage.setItem("adk_examDone", Boolean(state.examDone));
    localStorage.setItem("adk_missed", JSON.stringify(state.missed || []));
    reviewQueue = Array.isArray(state.reviews) ? state.reviews : [];
    stats = normalizeStats(state.stats);
    miniDone = Array.isArray(state.miniDone) ? state.miniDone : [];
    save(storageKeys.reviews, reviewQueue);
    save(storageKeys.stats, stats);
    save(storageKeys.miniDone, miniDone);
    localStorage.setItem("adk_state_updated", state.updatedAt || new Date().toISOString());
  }

  window.markLocalStateChanged = () => {
    localStorage.setItem("adk_state_updated", new Date().toISOString());
    window.queueCloudSync();
  };

  function mergeState(local, remote) {
    const reviews = new Map();
    [...(remote.reviews || []), ...(local.reviews || [])].forEach(card => {
      const key = `${card.prompt}\u0000${card.answer}`;
      const previous = reviews.get(key);
      if (!previous || Date.parse(card.updatedAt || card.dueAt) >= Date.parse(previous.updatedAt || previous.dueAt)) {
        reviews.set(key, card);
      }
    });
    return {
      done: Math.max(Number(local.done) || 0, Number(remote.done) || 0),
      unlocked: Math.max(Number(local.unlocked) || 1, Number(remote.unlocked) || 1),
      xp: Math.max(Number(local.xp) || 0, Number(remote.xp) || 0),
      examDone: Boolean(local.examDone || remote.examDone),
      missed: [...new Set([...(remote.missed || []), ...(local.missed || [])])],
      reviews: [...reviews.values()],
      stats: mergeStats(local.stats, remote.stats),
      miniDone: [...new Set([...(remote.miniDone || []), ...(local.miniDone || [])])],
      updatedAt: new Date().toISOString()
    };
  }

  function persistReviews() {
    save(storageKeys.reviews, reviewQueue);
    window.markLocalStateChanged();
    if (typeof window.rev === "function") window.rev();
    renderReviews();
    window.queueCloudSync();
  }

  window.nextQuestionMode = () => {
    const n = questionNumber++ % 3;
    if (n === 1) return { type: "typed" };
    if (n === 2) return { type: "truefalse", optionIndex: questionNumber };
    return { type: "choice" };
  };

  window.recordAttempt = correct => {
    const today = new Date().toISOString().slice(0, 10);
    stats = normalizeStats(stats);
    const bucket = stats.devices[deviceId] || (stats.devices[deviceId] = { answered: 0, correct: 0, days: {} });
    bucket.answered += 1;
    bucket.correct += correct ? 1 : 0;
    bucket.days[today] = (Number(bucket.days[today]) || 0) + 1;
    stats = normalizeStats(stats);
    save(storageKeys.stats, stats);
    window.markLocalStateChanged();
    renderDashboard();
    window.queueCloudSync();
  };

  window.scheduleReview = (prompt, answer) => {
    const existing = reviewQueue.find(card => card.prompt === prompt && card.answer === answer);
    if (existing) {
      existing.dueAt = new Date(Date.now() + 86400000).toISOString();
      existing.intervalDays = 1;
      existing.repetitions = 0;
      existing.updatedAt = new Date().toISOString();
    } else {
      reviewQueue.push({
        prompt,
        answer,
        dueAt: new Date(Date.now() + 86400000).toISOString(),
        intervalDays: 1,
        repetitions: 0,
        updatedAt: new Date().toISOString()
      });
    }
    persistReviews();
  };

  function renderReviews() {
    const container = $("#rv");
    if (!container) return;
    const now = Date.now();
    const due = reviewQueue.filter(card => Date.parse(card.dueAt) <= now);
    const cards = reviewFilter === "all" ? reviewQueue : due;
    const dueLabel = due.length ? `${due.length} سؤال برای مرور رسیده است.` : "فعلاً سؤالی برای مرور زمان‌بندی‌شده نرسیده است.";
    $("#review-summary").textContent = `${dueLabel} ${reviewQueue.length} سؤال در فهرست مرور داری.`;
    $("#cnt").textContent = due.length ? `(${due.length})` : "";
    $("#review-start").disabled = due.length === 0;
    $("#review-all").disabled = reviewQueue.length === 0;
    container.replaceChildren();
    if (!cards.length) {
      const empty = document.createElement("div");
      empty.className = "card mut";
      empty.textContent = reviewQueue.length
        ? "سؤال‌های ذخیره‌شده هنوز موعدشان نرسیده؛ می‌توانی مرور فوری را انتخاب کنی."
        : "هنوز اشتباهی ثبت نشده. سؤال‌هایی که اشتباه جواب بدهی اینجا با زمان‌بندی مرور می‌مانند.";
      container.appendChild(empty);
      return;
    }
    cards.forEach(card => {
      const article = document.createElement("article");
      article.className = "review-card";
      const prompt = document.createElement("b");
      prompt.textContent = card.prompt;
      const dueDate = document.createElement("p");
      dueDate.className = "small";
      dueDate.textContent = Date.parse(card.dueAt) <= now
        ? "موعد مرور رسیده"
        : `مرور بعدی: ${new Date(card.dueAt).toLocaleDateString("fa-IR")}`;
      const answer = document.createElement("p");
      answer.className = "answer";
      answer.textContent = `پاسخ: ${card.answer}`;
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "btn alt reveal";
      reveal.textContent = "نمایش پاسخ";
      reveal.onclick = () => {
        article.classList.add("revealed");
        reveal.hidden = true;
        controls.hidden = false;
      };
      const controls = document.createElement("div");
      controls.className = "actions";
      controls.hidden = true;
      const grade = (known, button) => {
        button.disabled = true;
        if (known) {
          card.repetitions = (Number(card.repetitions) || 0) + 1;
          card.intervalDays = reviewIntervals[Math.min(card.repetitions - 1, reviewIntervals.length - 1)];
        } else {
          card.repetitions = 0;
          card.intervalDays = 1;
        }
        card.dueAt = new Date(Date.now() + card.intervalDays * 86400000).toISOString();
        card.updatedAt = new Date().toISOString();
        window.recordAttempt(known);
        persistReviews();
      };
      [["بلدم ✅", true], ["دوباره مرور 🤔", false]].forEach(([label, known]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = known ? "btn ok" : "btn alt";
        button.textContent = label;
        button.onclick = () => grade(known, button);
        controls.appendChild(button);
      });
      article.append(prompt, dueDate, answer, reveal, controls);
      container.appendChild(article);
    });
  }

  $("#review-start").onclick = () => {
    reviewFilter = "due";
    renderReviews();
  };
  $("#review-all").onclick = () => {
    reviewFilter = "all";
    renderReviews();
  };

  function renderDashboard() {
    const root = $("#stats");
    if (!root) return;
    const answered = Number(stats.answered) || 0;
    const correct = Number(stats.correct) || 0;
    const days = Object.keys(stats.days || {}).length;
    const items = [
      ["درس‌های صرف", `${Number(localStorage.getItem("adk_done")) || 0} از ۵`],
      ["پاسخ درست", `${answered ? Math.round(correct / answered * 100) : 0}٪`],
      ["پاسخ‌های ثبت‌شده", answered],
      ["روزهای فعال", days],
      ["درس‌های نحو", `${miniDone.length} از ${miniLessons.length}`],
      ["امتیاز", Number(localStorage.getItem("adk_xp")) || 0]
    ];
    root.replaceChildren(...items.map(([label, value]) => {
      const tile = document.createElement("div");
      tile.className = "stat";
      const amount = document.createElement("b");
      amount.textContent = String(value);
      const caption = document.createElement("span");
      caption.textContent = label;
      tile.append(amount, caption);
      return tile;
    }));
    const daily = $("#daily-stats");
    daily.replaceChildren();
    const recent = Object.entries(stats.days || {}).sort(([a], [b]) => b.localeCompare(a)).slice(0, 7);
    if (!recent.length) {
      daily.textContent = "هنوز تمرینی ثبت نشده است.";
    } else {
      recent.forEach(([date, count]) => {
        const row = document.createElement("p");
        row.textContent = `${new Date(`${date}T00:00:00`).toLocaleDateString("fa-IR")}: ${count} پاسخ`;
        daily.appendChild(row);
      });
    }
  }

  function renderMiniCourses() {
    const root = $("#mini-courses");
    if (!root) return;
    root.replaceChildren(...miniLessons.map(lesson => {
      const article = document.createElement("article");
      article.className = "cd";
      const title = document.createElement("h3");
      title.textContent = lesson.title;
      const text = document.createElement("p");
      text.textContent = lesson.text;
      const question = document.createElement("p");
      question.textContent = lesson.question;
      const options = document.createElement("div");
      options.className = "actions";
      const message = document.createElement("p");
      message.className = "small";
      lesson.options.forEach((option, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn alt";
        button.textContent = option;
        button.onclick = () => {
          const correct = index === lesson.answer;
          [...options.children].forEach(item => item.disabled = true);
          button.className = correct ? "btn ok" : "btn no";
          message.textContent = correct ? "درست است، آفرین!" : `پاسخ درست: ${lesson.options[lesson.answer]}`;
          window.recordAttempt(correct);
          if (correct && !miniDone.includes(lesson.id)) {
            miniDone.push(lesson.id);
            save(storageKeys.miniDone, miniDone);
            renderDashboard();
          }
        };
        options.appendChild(button);
      });
      article.append(title, text, question, options, message);
      return article;
    }));
  }

  function getSupabaseConfig() {
    const config = window.SUPABASE_CONFIG || {};
    return { url: String(config.url || "").trim(), anonKey: String(config.anonKey || "").trim() };
  }

  async function connectSupabase() {
    const { url, anonKey } = getSupabaseConfig();
    if (!url || !anonKey) {
      setStatus($("#account-status"), "همگام‌سازی ابری هنوز تنظیم نشده؛ آدرس پروژه و anon key را در supabase-config.js وارد کن.");
      return;
    }
    try {
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
      supabase = createClient(url, anonKey);
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      currentUser = data.session?.user || null;
      await refreshAccount();
      supabase.auth.onAuthStateChange(() => {
        window.setTimeout(() => refreshAccount(), 0);
      });
    } catch (error) {
      console.error("اتصال Supabase ناموفق بود.", error);
      setStatus($("#account-status"), `اتصال به Supabase انجام نشد: ${error.message || error}`, "error");
    }
  }

  async function refreshAccount() {
    if (!supabase) return;
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      setStatus($("#account-status"), `دریافت وضعیت حساب ناموفق بود: ${error.message}`, "error");
      return;
    }
    currentUser = data.user;
    isAdmin = false;
    if (currentUser) {
      const profile = await supabase.from("profiles").select("role").eq("id", currentUser.id).maybeSingle();
      if (profile.error) {
        setStatus($("#account-status"), `دریافت نقش حساب ناموفق بود: ${profile.error.message}`, "error");
        return;
      }
      isAdmin = profile.data?.role === "admin";
      setStatus($("#account-status"), `وارد شده‌ای: ${currentUser.email}${isAdmin ? " · مدیر محتوا" : ""}`, "success");
      $("#auth-email").value = currentUser.email || "";
      $("#auth-email").disabled = true;
      $("#auth-password").hidden = true;
      $("#name-wrap").hidden = true;
      $("#sign-in").hidden = true;
      $("#sign-up").hidden = true;
      $("#sign-out").hidden = false;
      $("#sync-now").hidden = false;
      $("#admin-nav").hidden = !isAdmin;
      await syncCloudState();
      await loadCourses();
      if (isAdmin) await loadAdminContent();
      const code = localStorage.getItem("adk_cid");
      if (code) await loadCertificateCode();
    } else {
      isAdmin = false;
      setStatus($("#account-status"), "وارد نشده‌ای؛ می‌توانی مهمان بمانی یا برای همگام‌سازی وارد شوی.");
      $("#auth-email").disabled = false;
      $("#auth-password").hidden = false;
      $("#name-wrap").hidden = false;
      $("#sign-in").hidden = false;
      $("#sign-up").hidden = false;
      $("#sign-out").hidden = true;
      $("#sync-now").hidden = true;
      $("#admin-nav").hidden = true;
      renderCloudCourses([]);
      await loadCourses();
    }
    if (location.hash === "#admin" && !isAdmin) location.hash = "account";
    renderDashboard();
  }

  function syncCloudState() {
    if (!supabase || !currentUser) return Promise.resolve(false);
    if (syncPromise) {
      syncRequested = true;
      return syncPromise;
    }
    syncPromise = (async () => {
      let result;
      do {
        syncRequested = false;
        result = await syncCloudStateOnce();
      } while (result && syncRequested);
      return result;
    })().finally(() => {
      syncPromise = null;
    });
    return syncPromise;
  }

  async function syncCloudStateOnce() {
    try {
      const local = localState();
      const { data, error } = await supabase.from("learner_state")
        .select("state")
        .eq("user_id", currentUser.id)
        .maybeSingle();
      if (error) {
        setStatus($("#account-status"), `دریافت پیشرفت ابری ناموفق بود: ${error.message}`, "error");
        return false;
      }
      const merged = mergeState(local, data?.state || {});
      applyingCloudState = true;
      saveState(merged);
      if (typeof window.render === "function") window.render();
      renderDashboard();
      renderReviews();
      applyingCloudState = false;
      const saved = await supabase.from("learner_state").upsert({
        user_id: currentUser.id,
        state: merged,
        updated_at: new Date().toISOString()
      });
      if (saved.error) {
        setStatus($("#account-status"), `ذخیرهٔ پیشرفت ابری ناموفق بود: ${saved.error.message}`, "error");
        return false;
      }
      setStatus($("#account-status"), `پیشرفت همگام شد · آخرین همگام‌سازی ${new Date().toLocaleTimeString("fa-IR")}`, "success");
      return true;
    } catch (error) {
      console.error("همگام‌سازی پیشرفت ناموفق بود.", error);
      setStatus($("#account-status"), `همگام‌سازی ناموفق بود: ${error.message || error}`, "error");
      return false;
    } finally {
      applyingCloudState = false;
    }
  }

  window.queueCloudSync = () => {
    if (!supabase || !currentUser || applyingCloudState) return;
    if (syncPromise) {
      syncRequested = true;
      return;
    }
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => syncCloudState(), 1200);
  };

  $("#auth-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!supabase) {
      setStatus($("#account-status"), "ابتدا Supabase را در supabase-config.js تنظیم کن.", "error");
      return;
    }
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setStatus($("#account-status"), `ورود انجام نشد: ${error.message}`, "error");
    else await refreshAccount();
  });

  $("#sign-up").onclick = async () => {
    if (!supabase) {
      setStatus($("#account-status"), "ابتدا Supabase را در supabase-config.js تنظیم کن.", "error");
      return;
    }
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    const displayName = $("#auth-name").value.trim();
    if (!email || password.length < 8) {
      setStatus($("#account-status"), "ایمیل معتبر و گذرواژهٔ حداقل ۸ حرفی وارد کن.", "error");
      return;
    }
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } }
    });
    if (error) setStatus($("#account-status"), `ساخت حساب انجام نشد: ${error.message}`, "error");
    else if (!data.session) setStatus($("#account-status"), "حساب ساخته شد؛ ایمیلت را برای تأیید باز کن، سپس وارد شو.", "success");
    else await refreshAccount();
  };

  $("#sign-out").onclick = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) setStatus($("#account-status"), `خروج انجام نشد: ${error.message}`, "error");
    else await refreshAccount();
  };
  $("#sync-now").onclick = () => syncCloudState();

  async function loadCourses() {
    if (!supabase) return;
    const { data, error } = await supabase.from("courses")
      .select("id,title,description,published,enrollment_open")
      .order("created_at", { ascending: false });
    if (error) {
      setStatus($("#account-status"), `بارگیری دوره‌ها ناموفق بود: ${error.message}`, "error");
      return;
    }
    coursesCache = data || [];
    const lessonResult = await supabase.from("lessons")
      .select("id,course_id,order_index,title,content,audio_url,published")
      .order("course_id")
      .order("order_index");
    if (lessonResult.error) {
      setStatus($("#account-status"), `بارگیری درس‌ها ناموفق بود: ${lessonResult.error.message}`, "error");
      return;
    }
    lessonsCache = lessonResult.data || [];
    if (currentUser) {
      const enrollmentResult = await supabase.from("course_enrollments")
        .select("course_id")
        .eq("user_id", currentUser.id);
      if (enrollmentResult.error) {
        setStatus($("#account-status"), `دریافت ثبت‌نام‌ها ناموفق بود: ${enrollmentResult.error.message}`, "error");
        return;
      }
      enrolledCourseIds = new Set((enrollmentResult.data || []).map(item => item.course_id));
    } else {
      enrolledCourseIds = new Set();
    }
    renderCloudCourses(coursesCache);
    populateCourseSelect();
  }

  function renderCloudCourses(courses) {
    const root = $("#cloud-courses");
    if (!root) return;
    root.replaceChildren();
    if (!courses.length) {
      const empty = document.createElement("p");
      empty.className = "mut";
      empty.textContent = supabase
        ? "هنوز دورهٔ آنلاینی منتشر نشده است."
        : "برای نمایش دوره‌های آنلاین، حساب Supabase را تنظیم کن.";
      root.appendChild(empty);
      return;
    }
    courses.filter(course => course.published || isAdmin).forEach(course => {
      const article = document.createElement("article");
      article.className = "cloud-course";
      const title = document.createElement("h3");
      title.textContent = course.title;
      const description = document.createElement("p");
      description.textContent = course.description || "";
      const enrollmentStatus = document.createElement("p");
      enrollmentStatus.className = "small";
      enrollmentStatus.textContent = course.enrollment_open ? "ثبت‌نام این دوره باز است." : "ثبت‌نام این دوره بسته است.";
      const enrollmentButton = document.createElement("button");
      enrollmentButton.type = "button";
      enrollmentButton.className = "btn alt";
      enrollmentButton.textContent = enrolledCourseIds.has(course.id) ? "ثبت‌نام شده" : "ثبت‌نام در دوره";
      enrollmentButton.disabled = enrolledCourseIds.has(course.id) || !course.enrollment_open;
      enrollmentButton.onclick = () => enrollInCourse(course);
      article.append(title, description, enrollmentStatus, enrollmentButton);
      const courseLessons = lessonsCache.filter(lesson => lesson.course_id === course.id && (lesson.published || isAdmin));
      courseLessons.sort((a, b) => a.order_index - b.order_index).forEach(lesson => {
        const item = document.createElement("div");
        item.className = "course-lesson";
        const heading = document.createElement("b");
        heading.textContent = `${lesson.order_index}. ${lesson.title}`;
        const content = document.createElement("p");
        const lessonContent = lesson.content;
        content.textContent = typeof lessonContent === "string"
          ? lessonContent
          : lessonContent?.text || lessonContent?.body || "";
        item.append(heading, content);
        if (Array.isArray(lessonContent?.questions)) {
          lessonContent.questions.forEach(questionData => {
            if (!Array.isArray(questionData.options) || !questionData.options.length) return;
            const prompt = document.createElement("p");
            prompt.textContent = questionData.prompt || questionData.question || "";
            const choices = document.createElement("div");
            choices.className = "actions";
            const result = document.createElement("p");
            result.className = "small";
            questionData.options.forEach((option, index) => {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "btn alt";
              button.textContent = option;
              button.onclick = () => {
                const correctIndex = Number(questionData.answer ?? questionData.correctIndex);
                const correct = index === correctIndex;
                [...choices.children].forEach(choice => choice.disabled = true);
                button.className = correct ? "btn ok" : "btn no";
                result.textContent = correct ? "پاسخ درست است." : `پاسخ درست: ${questionData.options[correctIndex]}`;
                window.recordAttempt(correct);
              };
              choices.appendChild(button);
            });
            item.append(prompt, choices, result);
          });
        }
        if (lesson.audio_url && /^https:\/\//i.test(lesson.audio_url)) {
          const audio = document.createElement("audio");
          audio.controls = true;
          audio.preload = "none";
          audio.src = lesson.audio_url;
          item.appendChild(audio);
        }
        article.appendChild(item);
      });
      root.appendChild(article);
    });
  }

  async function enrollInCourse(course) {
    if (!currentUser) {
      setStatus($("#account-status"), "برای ثبت‌نام در دوره ابتدا وارد حساب کاربری شو.", "error");
      location.hash = "account";
      return;
    }
    if (!course.enrollment_open) {
      setStatus($("#account-status"), "ثبت‌نام این دوره بسته است.", "error");
      return;
    }
    const { error } = await supabase.from("course_enrollments").insert({
      user_id: currentUser.id,
      course_id: course.id
    });
    if (error) {
      setStatus($("#account-status"), `ثبت‌نام در دوره ناموفق بود: ${error.message}`, "error");
      return;
    }
    enrolledCourseIds.add(course.id);
    renderCloudCourses(coursesCache);
    setStatus($("#account-status"), `در دورهٔ «${course.title}» ثبت‌نام شدی.`, "success");
  }

  function populateCourseSelect() {
    const select = $("#lesson-course");
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    coursesCache.forEach(course => {
      const option = document.createElement("option");
      option.value = course.id;
      option.textContent = course.title;
      select.appendChild(option);
    });
    if (coursesCache.some(course => course.id === previous)) select.value = previous;
  }

  async function loadAdminUsers() {
    const [profilesResult, statesResult, enrollmentsResult] = await Promise.all([
      supabase.from("profiles").select("id,email,display_name,role,created_at").order("created_at", { ascending: false }),
      supabase.from("learner_state").select("user_id,state"),
      supabase.from("course_enrollments").select("user_id,course_id")
    ]);
    const failed = [profilesResult, statesResult, enrollmentsResult].find(result => result.error);
    if (failed) {
      setStatus($("#admin-status"), `بارگیری کاربران ناموفق بود: ${failed.error.message}`, "error");
      return;
    }

    const states = new Map((statesResult.data || []).map(item => [item.user_id, item.state || {}]));
    const enrollmentCounts = new Map();
    (enrollmentsResult.data || []).forEach(item => {
      enrollmentCounts.set(item.user_id, (enrollmentCounts.get(item.user_id) || 0) + 1);
    });
    const users = profilesResult.data || [];
    const root = $("#admin-users");
    root.replaceChildren();
    users.forEach(profile => {
      const state = states.get(profile.id) || {};
      const card = document.createElement("article");
      card.className = "card admin-user";
      const email = document.createElement("b");
      email.textContent = profile.email || "ایمیل ثبت نشده";
      const details = document.createElement("p");
      details.className = "admin-user-meta";
      details.textContent = `عضویت: ${new Date(profile.created_at).toLocaleDateString("fa-IR")} · ثبت‌نام در ${enrollmentCounts.get(profile.id) || 0} دوره · پاسخ‌ها: ${Number(state.stats?.answered) || 0}`;
      const form = document.createElement("div");
      form.className = "actions";
      const name = document.createElement("input");
      name.className = "inp";
      name.maxLength = 120;
      name.value = profile.display_name || "";
      name.setAttribute("aria-label", `نام نمایشی ${profile.email || ""}`);
      const role = document.createElement("select");
      role.className = "inp";
      role.setAttribute("aria-label", `نقش ${profile.email || ""}`);
      [["student", "کاربر"], ["admin", "مدیر"]].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        role.appendChild(option);
      });
      role.value = profile.role;
      const saveProfile = document.createElement("button");
      saveProfile.type = "button";
      saveProfile.className = "btn alt";
      saveProfile.textContent = "ذخیرهٔ کاربر";
      saveProfile.onclick = async () => {
        saveProfile.disabled = true;
        const result = await supabase.rpc("admin_update_profile", {
          p_user_id: profile.id,
          p_display_name: name.value.trim(),
          p_role: role.value
        });
        saveProfile.disabled = false;
        if (result.error) {
          setStatus($("#admin-status"), `ویرایش کاربر ناموفق بود: ${result.error.message}`, "error");
          return;
        }
        setStatus($("#admin-status"), "اطلاعات کاربر ذخیره شد.", "success");
        if (profile.id === currentUser.id && role.value !== "admin") {
          await refreshAccount();
          return;
        }
        await loadAdminUsers();
      };
      form.append(name, role, saveProfile);
      card.append(email, details, form);
      root.appendChild(card);
    });
    const summary = $("#admin-summary");
    const lessonCount = lessonsCache.length;
    const stats = [
      ["کاربران", users.length],
      ["دوره‌ها", coursesCache.length],
      ["درس‌ها", lessonCount],
      ["ثبت‌نام‌ها", (enrollmentsResult.data || []).length]
    ];
    summary.replaceChildren(...stats.map(([label, value]) => {
      const tile = document.createElement("div");
      tile.className = "stat";
      const count = document.createElement("b");
      count.textContent = String(value);
      const caption = document.createElement("span");
      caption.textContent = label;
      tile.append(count, caption);
      return tile;
    }));
  }

  async function loadAdminContent() {
    if (!supabase || !isAdmin) return;
    const { data, error } = await supabase.from("lessons")
      .select("id,course_id,order_index,title,content,audio_url,published")
      .order("course_id")
      .order("order_index");
    if (error) {
      setStatus($("#admin-status"), `بارگیری محتوا ناموفق بود: ${error.message}`, "error");
      return;
    }
    lessonsCache = data || [];
    renderCloudCourses(coursesCache);
    const root = $("#admin-content");
    root.replaceChildren();
    coursesCache.forEach(course => {
      const row = document.createElement("div");
      row.className = "card";
      const title = document.createElement("b");
      title.textContent = `${course.title} (${course.id}) · ${course.published ? "منتشرشده" : "پیش‌نویس"} · ثبت‌نام ${course.enrollment_open ? "باز" : "بسته"}`;
      const actions = document.createElement("div");
      actions.className = "actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn alt";
      edit.textContent = "ویرایش دوره";
      edit.onclick = () => {
        editingCourseId = course.id;
        $("#course-id").value = course.id;
        $("#course-id").readOnly = true;
        $("#course-title").value = course.title;
        $("#course-description").value = course.description;
        $("#course-published").value = String(course.published);
        $("#course-enrollment").value = String(course.enrollment_open);
        $("#course-form-title").textContent = "ویرایش دوره";
        $("#course-cancel").hidden = false;
        $("#course-title").focus();
      };
      const publish = document.createElement("button");
      publish.type = "button";
      publish.className = "btn alt";
      publish.textContent = course.published ? "پیش‌نویس‌کردن" : "انتشار دوره";
      publish.onclick = () => updateCourse(course.id, { published: !course.published });
      const enrollment = document.createElement("button");
      enrollment.type = "button";
      enrollment.className = "btn alt";
      enrollment.textContent = course.enrollment_open ? "بستن ثبت‌نام" : "بازکردن ثبت‌نام";
      enrollment.onclick = () => updateCourse(course.id, { enrollment_open: !course.enrollment_open });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn alt";
      remove.textContent = "حذف دوره";
      remove.onclick = async () => {
        if (!window.confirm(`دورهٔ «${course.title}»، درس‌ها و ثبت‌نام‌هایش حذف شود؟`)) return;
        const result = await supabase.from("courses").delete().eq("id", course.id);
        if (result.error) setStatus($("#admin-status"), `حذف دوره ناموفق بود: ${result.error.message}`, "error");
        else {
          setStatus($("#admin-status"), "دوره حذف شد.", "success");
          await loadCourses();
          await loadAdminContent();
        }
      };
      actions.append(edit, publish, enrollment, remove);
      row.append(title, actions);
      root.appendChild(row);
    });
    lessonsCache.forEach(lesson => {
      const row = document.createElement("div");
      row.className = "card";
      const title = document.createElement("b");
      title.textContent = `${lesson.title} (${lesson.id}) · ${lesson.course_id} · ${lesson.published ? "منتشرشده" : "پیش‌نویس"}`;
      const actions = document.createElement("div");
      actions.className = "actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn alt";
      edit.textContent = "ویرایش درس";
      edit.onclick = () => {
        editingLessonId = lesson.id;
        $("#lesson-course").value = lesson.course_id;
        $("#lesson-id").value = lesson.id;
        $("#lesson-id").readOnly = true;
        $("#lesson-title").value = lesson.title;
        $("#lesson-order").value = lesson.order_index;
        $("#lesson-content").value = JSON.stringify(lesson.content, null, 2);
        $("#lesson-published").value = String(lesson.published);
        $("#lesson-form-title").textContent = "ویرایش درس";
        $("#lesson-cancel").hidden = false;
        $("#lesson-title").focus();
      };
      const publish = document.createElement("button");
      publish.type = "button";
      publish.className = "btn alt";
      publish.textContent = lesson.published ? "پیش‌نویس‌کردن" : "انتشار درس";
      publish.onclick = async () => {
        const result = await supabase.from("lessons").update({ published: !lesson.published }).eq("id", lesson.id);
        if (result.error) setStatus($("#admin-status"), `تغییر وضعیت درس ناموفق بود: ${result.error.message}`, "error");
        else {
          await loadCourses();
          await loadAdminContent();
        }
      };
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn alt";
      remove.textContent = "حذف درس";
      remove.onclick = async () => {
        if (!window.confirm(`درس «${lesson.title}» حذف شود؟`)) return;
        const result = await supabase.from("lessons").delete().eq("id", lesson.id);
        if (result.error) setStatus($("#admin-status"), `حذف درس ناموفق بود: ${result.error.message}`, "error");
        else {
          setStatus($("#admin-status"), "درس حذف شد.", "success");
          await loadCourses();
          await loadAdminContent();
        }
      };
      actions.append(edit, publish, remove);
      row.append(title, actions);
      root.appendChild(row);
    });
    populateCourseSelect();
    await loadAdminUsers();
  }

  async function updateCourse(courseId, changes) {
    const { error } = await supabase.from("courses").update(changes).eq("id", courseId);
    if (error) {
      setStatus($("#admin-status"), `به‌روزرسانی دوره ناموفق بود: ${error.message}`, "error");
      return;
    }
    setStatus($("#admin-status"), "وضعیت دوره به‌روزرسانی شد.", "success");
    await loadCourses();
    await loadAdminContent();
  }

  function resetCourseForm() {
    editingCourseId = null;
    $("#course-form").reset();
    $("#course-id").readOnly = false;
    $("#course-published").value = "true";
    $("#course-enrollment").value = "true";
    $("#course-form-title").textContent = "افزودن دوره";
    $("#course-cancel").hidden = true;
  }

  function resetLessonForm() {
    editingLessonId = null;
    $("#lesson-form").reset();
    $("#lesson-id").readOnly = false;
    $("#lesson-order").value = "1";
    $("#lesson-published").value = "true";
    $("#lesson-content").value = '{"text":"متن درس را اینجا بنویسید","questions":[]}';
    $("#lesson-form-title").textContent = "افزودن درس";
    $("#lesson-cancel").hidden = true;
  }

  $("#course-cancel").onclick = resetCourseForm;
  $("#lesson-cancel").onclick = resetLessonForm;

  $("#course-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!isAdmin) return setStatus($("#admin-status"), "این عملیات فقط برای مدیر محتوا فعال است.", "error");
    const course = {
      title: $("#course-title").value.trim(),
      description: $("#course-description").value.trim(),
      published: $("#course-published").value === "true",
      enrollment_open: $("#course-enrollment").value === "true"
    };
    const result = editingCourseId
      ? await supabase.from("courses").update(course).eq("id", editingCourseId)
      : await supabase.from("courses").insert({ ...course, id: $("#course-id").value.trim() });
    const { error } = result;
    if (error) return setStatus($("#admin-status"), `ذخیرهٔ دوره ناموفق بود: ${error.message}`, "error");
    setStatus($("#admin-status"), "دوره ذخیره شد.", "success");
    resetCourseForm();
    await loadCourses();
    await loadAdminContent();
  });

  $("#lesson-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!isAdmin) return setStatus($("#admin-status"), "این عملیات فقط برای مدیر محتوا فعال است.", "error");
    let content;
    try {
      content = JSON.parse($("#lesson-content").value);
    } catch (error) {
      return setStatus($("#admin-status"), `JSON محتوا معتبر نیست: ${error.message}`, "error");
    }
    if (!content || typeof content !== "object" || Array.isArray(content) ||
      (content.questions !== undefined && (!Array.isArray(content.questions) || content.questions.some(question =>
      !question || typeof question !== "object" ||
      !Array.isArray(question.options) ||
      !Number.isInteger(Number(question.answer ?? question.correctIndex)) ||
      Number(question.answer ?? question.correctIndex) < 0 ||
      Number(question.answer ?? question.correctIndex) >= question.options.length
    )))) {
      return setStatus($("#admin-status"), "هر سؤال باید گزینه‌ها و شمارهٔ پاسخ درست معتبر داشته باشد.", "error");
    }
    const file = $("#lesson-audio").files[0];
    if (file && (!file.type.startsWith("audio/") || file.size > 10 * 1024 * 1024)) {
      return setStatus($("#admin-status"), "فایل صوتی باید از نوع صدا و حداکثر ۱۰ مگابایت باشد.", "error");
    }
    const lesson = {
      id: $("#lesson-id").value.trim(),
      course_id: $("#lesson-course").value,
      order_index: Number($("#lesson-order").value),
      title: $("#lesson-title").value.trim(),
      content,
      published: $("#lesson-published").value === "true"
    };
    const result = editingLessonId
      ? await supabase.from("lessons").update(lesson).eq("id", editingLessonId)
      : await supabase.from("lessons").insert(lesson);
    const { error } = result;
    if (error) return setStatus($("#admin-status"), `ذخیرهٔ درس ناموفق بود: ${error.message}`, "error");
    if (file) {
      const path = `${lesson.course_id}/${lesson.id}-${Date.now()}`;
      const uploaded = await supabase.storage.from("lesson-audio").upload(path, file, {
        contentType: file.type,
        upsert: true
      });
      if (uploaded.error) return setStatus($("#admin-status"), `درس ذخیره شد اما بارگذاری صدا ناموفق بود: ${uploaded.error.message}`, "error");
      lesson.audio_url = supabase.storage.from("lesson-audio").getPublicUrl(path).data.publicUrl;
      const updated = await supabase.from("lessons").update({ audio_url: lesson.audio_url }).eq("id", lesson.id);
      if (updated.error) return setStatus($("#admin-status"), `درس و فایل صوتی ذخیره شدند، اما ثبت نشانی صدا ناموفق بود: ${updated.error.message}`, "error");
    }
    setStatus($("#admin-status"), "درس ذخیره شد.", "success");
    resetLessonForm();
    await loadCourses();
    await loadAdminContent();
  });

  async function loadCertificateCode() {
    if (!supabase || !currentUser) return;
    const { data, error } = await supabase.from("certificates")
      .select("code,recipient_name")
      .eq("user_id", currentUser.id)
      .eq("course_id", "sarf-unit-1")
      .maybeSingle();
    if (error) {
      setStatus($("#account-status"), `دریافت گواهی ناموفق بود: ${error.message}`, "error");
      return;
    }
    if (data) {
      localStorage.setItem("adk_cid", data.code);
      localStorage.setItem(storageKeys.certificate, JSON.stringify(data));
      cid = data.code;
      if (location.hash === "#cert" && typeof window.certView === "function") window.certView();
    }
  }

  window.issueCertificate = async () => {
    if (!supabase || !currentUser) {
      setStatus($("#account-status"), "برای صدور شناسهٔ قابل‌بررسی، وارد حساب Supabase شو؛ گواهی محلی فعلی فقط نمایشی است.");
      return;
    }
    const name = localStorage.getItem("adk_name") || "";
    const sync = await syncCloudState();
    if (sync === false) return;
    const { data, error } = await supabase.rpc("issue_certificate", {
      p_course_id: "sarf-unit-1",
      p_recipient_name: name
    });
    if (error) {
      setStatus($("#account-status"), `صدور شناسهٔ گواهی ناموفق بود: ${error.message}`, "error");
      return;
    }
    const certificate = Array.isArray(data) ? data[0] : data;
    if (certificate?.code) {
      localStorage.setItem("adk_cid", certificate.code);
      localStorage.setItem(storageKeys.certificate, JSON.stringify(certificate));
      cid = certificate.code;
      if (location.hash === "#cert" && typeof window.certView === "function") window.certView();
    }
  };

  $("#verify-form").addEventListener("submit", async event => {
    event.preventDefault();
    const code = $("#verify-code").value.trim().toUpperCase();
    if (!supabase) {
      setStatus($("#verify-result"), "بررسی آنلاین گواهی نیازمند تنظیم Supabase است.", "error");
      return;
    }
    const { data, error } = await supabase.rpc("verify_certificate", { p_code: code });
    if (error) return setStatus($("#verify-result"), `بررسی گواهی ناموفق بود: ${error.message}`, "error");
    const certificate = Array.isArray(data) ? data[0] : data;
    if (!certificate) return setStatus($("#verify-result"), "گواهی‌ای با این شناسه پیدا نشد.", "error");
    setStatus($("#verify-result"), `شناسه معتبر است · دوره: ${certificate.course_id} · تاریخ صدور: ${new Date(certificate.issued_at).toLocaleDateString("fa-IR")}`, "success");
  });

  window.addEventListener("hashchange", () => {
    if (location.hash === "#admin" && !isAdmin) location.hash = "account";
    if (location.hash === "#review") renderReviews();
    if (location.hash === "#dashboard") renderDashboard();
    if (location.hash === "#cert" && currentUser) loadCertificateCode();
  });
  window.addEventListener("online", () => {
    if (currentUser) syncCloudState();
  });

  renderMiniCourses();
  renderDashboard();
  renderReviews();
  if (migratedReviews) save(storageKeys.reviews, reviewQueue);
  connectSupabase();

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("./sw.js").catch(error => {
      console.error("ثبت حالت آفلاین ناموفق بود.", error);
    });
  }
})();
