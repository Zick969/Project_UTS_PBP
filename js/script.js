document.addEventListener("DOMContentLoaded", () => {
  const music = document.getElementById("backgroundMusic");
  const musicToggle = document.getElementById("musicToggle");
  const openInvitation = document.getElementById("openInvitation");
  const musicIcon = musicToggle.querySelector("i");
  const navCollapse = document.getElementById("mainNav");
  const backToTop = document.getElementById("backToTop");

  /* =========================================================
     BACKSOUND
     - Diputar otomatis saat halaman dibuka.
     - Looping mulus tanpa jeda memakai Web Audio API (buffer di-loop
       sample-accurate, hening di awal/akhir dipangkas, dan ujung lagu
       di-crossfade ke awal lagu).
     - Browser memblokir suara otomatis sebelum ada interaksi. Jadi musik
       dicoba diputar seketika; bila diblokir, musik mulai pada sentuhan /
       klik / tombol keyboard pertama di mana saja pada halaman.
     ========================================================= */
  const TARGET_VOLUME = 0.3;       // volume sama seperti sebelumnya
  const CROSSFADE_SECONDS = 1.6;   // lama tumpang-tindih ujung lagu -> awal lagu
  const SILENCE_THRESHOLD = 0.004; // batas amplitudo yang dianggap "hening"
  const FADE_IN_SECONDS = 1.5;

  let audioCtx = null;
  let masterGain = null;
  let engine = "loading";          // "loading" | "webaudio" | "element"
  let userPaused = false;          // true bila pengunjung sengaja menekan jeda
  let hasStarted = false;          // true setelah suara benar-benar berjalan

  function isPlaying() {
    if (engine === "webaudio") return !!audioCtx && audioCtx.state === "running" && !userPaused;
    if (engine === "element") return !music.paused && !music.muted && !userPaused;
    return false;
  }

  function updateMusicButton() {
    const playing = isPlaying();
    musicIcon.className = playing ? "bi bi-pause-fill" : "bi bi-music-note";
    musicToggle.setAttribute("aria-label", playing ? "Hentikan musik" : "Putar musik");
    musicToggle.title = playing ? "Hentikan musik" : "Putar musik";
    musicToggle.classList.toggle("is-playing", playing);
  }

  // Membuat buffer loop yang mulus: pangkas hening, lalu crossfade ujung -> awal.
  function buildSeamlessLoop(ctx, decoded) {
    const sampleRate = decoded.sampleRate;
    const channels = decoded.numberOfChannels;
    const total = decoded.length;
    const data = [];
    for (let c = 0; c < channels; c++) data.push(decoded.getChannelData(c));

    let first = 0;
    let last = total - 1;
    const audible = (i) => {
      for (let c = 0; c < channels; c++) if (Math.abs(data[c][i]) > SILENCE_THRESHOLD) return true;
      return false;
    };
    while (first < total && !audible(first)) first++;
    while (last > first && !audible(last)) last--;

    const length = last - first + 1;
    if (length < sampleRate * 2) return decoded; // terlalu pendek, pakai apa adanya

    const fade = Math.min(Math.floor(CROSSFADE_SECONDS * sampleRate), Math.floor(length / 3));
    const outLength = length - fade;
    const out = ctx.createBuffer(channels, outLength, sampleRate);

    for (let c = 0; c < channels; c++) {
      const src = data[c];
      const dst = out.getChannelData(c);
      for (let i = 0; i < outLength; i++) dst[i] = src[first + i];
      // Awal loop = awal lagu (naik) + ujung lagu (turun), daya sama (equal-power).
      for (let i = 0; i < fade; i++) {
        const t = i / fade;
        dst[i] = src[first + i] * Math.sin(t * Math.PI / 2) + src[first + outLength + i] * Math.cos(t * Math.PI / 2);
      }
    }
    return out;
  }

  function decodeAudio(ctx, arrayBuffer) {
    return new Promise((resolve, reject) => {
      const maybePromise = ctx.decodeAudioData(arrayBuffer, resolve, reject); // callback untuk Safari lama
      if (maybePromise && typeof maybePromise.then === "function") maybePromise.then(resolve, reject);
    });
  }

  function safeResume() {
    if (!audioCtx) return Promise.resolve();
    return audioCtx.resume().catch(() => {});
  }

  function onContextStateChange() {
    if (audioCtx && audioCtx.state === "running" && !userPaused) hasStarted = true;
    if (hasStarted) removeUnlockListeners();
    updateMusicButton();
  }

  async function startWebAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio API tidak tersedia");

    audioCtx = new AudioContextClass();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(audioCtx.destination);
    audioCtx.addEventListener("statechange", onContextStateChange);

    // Coba langsung jalan (berhasil bila browser mengizinkan autoplay).
    safeResume();

    const response = await fetch(music.getAttribute("src"));
    if (!response.ok) throw new Error("Gagal memuat audio: " + response.status);
    const decoded = await decodeAudio(audioCtx, await response.arrayBuffer());
    const loopBuffer = buildSeamlessLoop(audioCtx, decoded);

    const source = audioCtx.createBufferSource();
    source.buffer = loopBuffer;
    source.loop = true;                       // loop pada level sample: tanpa jeda
    source.connect(masterGain);

    const now = audioCtx.currentTime;         // bernilai tetap saat context masih "suspended"
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(0, now);
    masterGain.gain.linearRampToValueAtTime(TARGET_VOLUME, now + FADE_IN_SECONDS);
    source.start(0);                          // mulai bersamaan saat context diizinkan berjalan

    engine = "webaudio";
    onContextStateChange();
  }

  // Cadangan bila Web Audio tidak bisa dipakai (misal index.html dibuka langsung lewat file://).
  function startElementFallback() {
    engine = "element";
    music.volume = TARGET_VOLUME;
    music.preload = "auto";
    music.loop = true;

    // Sambungkan ujung -> awal sebelum jeda bawaan loop terjadi (dan lewati hening di awal file).
    const FALLBACK_LOOP_START = 0.15;
    window.setInterval(() => {
      if (!music.paused && music.duration && music.currentTime > music.duration - 0.08) {
        music.currentTime = FALLBACK_LOOP_START;
      }
    }, 40);

    // Autoplay bersuara biasanya ditolak; autoplay tanpa suara diizinkan, lalu dinyalakan saat ada interaksi.
    music.muted = false;
    music.play().catch(() => {
      music.muted = true;
      music.play().catch(() => {});
    }).finally(updateMusicButton);
  }

  function playMusic() {
    userPaused = false;
    if (engine === "webaudio") {
      if (audioCtx.state !== "running") {
        const t = audioCtx.currentTime;
        masterGain.gain.cancelScheduledValues(t);
        masterGain.gain.setValueAtTime(0, t);
        masterGain.gain.linearRampToValueAtTime(TARGET_VOLUME, t + 0.6);
        safeResume();
      }
    } else if (engine === "element") {
      music.muted = false;
      music.play().catch(() => {});
    } else if (audioCtx) {
      safeResume(); // audio masih diunduh; context langsung disiapkan agar begitu siap, langsung berbunyi
    }
    updateMusicButton();
  }

  function pauseMusic() {
    userPaused = true;
    if (engine === "webaudio") {
      const t = audioCtx.currentTime;
      masterGain.gain.cancelScheduledValues(t);
      masterGain.gain.setValueAtTime(masterGain.gain.value, t);
      masterGain.gain.linearRampToValueAtTime(0, t + 0.25);
      window.setTimeout(() => { if (userPaused) audioCtx.suspend().catch(() => {}); }, 280);
    } else if (engine === "element") {
      music.pause();
    }
    updateMusicButton();
  }

  // Interaksi pertama (di mana saja) membuka kunci autoplay browser.
  const unlockEvents = ["pointerup", "touchend", "click", "keydown"];
  function onFirstInteraction(event) {
    if (event.target && event.target.closest && event.target.closest("#musicToggle")) return; // tombol musik punya logikanya sendiri
    if (userPaused) return;
    if (engine === "element") music.muted = false;
    playMusic();
  }
  function removeUnlockListeners() {
    unlockEvents.forEach((name) => document.removeEventListener(name, onFirstInteraction, true));
  }
  unlockEvents.forEach((name) => document.addEventListener(name, onFirstInteraction, true));

  // Setelah kembali ke tab / layar menyala lagi (iOS bisa menghentikan audio), lanjutkan musik.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || userPaused || !hasStarted) return;
    if (engine === "webaudio" && audioCtx.state !== "running") safeResume();
    if (engine === "element" && music.paused) music.play().catch(() => {});
  });

  openInvitation.addEventListener("click", () => {
    playMusic();
    document.getElementById("mempelai").scrollIntoView({ behavior: "smooth" });
  });

  musicToggle.addEventListener("click", () => {
    if (isPlaying()) {
      pauseMusic();
    } else {
      playMusic();
    }
  });

  music.addEventListener("play", updateMusicButton);
  music.addEventListener("pause", updateMusicButton);
  music.addEventListener("ended", updateMusicButton);
  music.addEventListener("volumechange", updateMusicButton);

  startWebAudio().catch((error) => {
    console.info("Web Audio tidak dapat dipakai, beralih ke pemutar standar.", error);
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    startElementFallback();
  });

  // Tutup menu mobile setelah salah satu tautan navigasi dipilih.
  document.querySelectorAll(".navbar-nav .nav-link").forEach((link) => {
    link.addEventListener("click", () => {
      if (window.bootstrap && navCollapse.classList.contains("show")) {
        bootstrap.Collapse.getOrCreateInstance(navCollapse).hide();
      }
    });
  });

  // Menandai menu navigasi yang sedang aktif berdasarkan bagian yang terlihat.
  const sections = document.querySelectorAll("main section[id]");
  const navLinks = document.querySelectorAll(".navbar-nav .nav-link");
  const sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        navLinks.forEach((link) => {
          link.classList.toggle("active", link.getAttribute("href") === `#${entry.target.id}`);
        });
      }
    });
  }, { rootMargin: "-35% 0px -55% 0px" });
  sections.forEach((section) => sectionObserver.observe(section));

  // Countdown contoh: 12 April 2027 pukul 08.00 WIB (UTC+7).
  const weddingDate = new Date("2027-04-12T08:00:00+07:00").getTime();
  const countdownTimer = window.setInterval(() => {
    const distance = weddingDate - Date.now();
    if (distance <= 0) {
      ["days", "hours", "minutes", "seconds"].forEach((id) => {
        document.getElementById(id).textContent = "00";
      });
      window.clearInterval(countdownTimer);
      return;
    }
    document.getElementById("days").textContent = String(Math.floor(distance / 86400000)).padStart(2, "0");
    document.getElementById("hours").textContent = String(Math.floor((distance % 86400000) / 3600000)).padStart(2, "0");
    document.getElementById("minutes").textContent = String(Math.floor((distance % 3600000) / 60000)).padStart(2, "0");
    document.getElementById("seconds").textContent = String(Math.floor((distance % 60000) / 1000)).padStart(2, "0");
  }, 1000);

  // Tombol kembali ke atas.
  window.addEventListener("scroll", () => {
    backToTop.classList.toggle("show", window.scrollY > 450);
  }, { passive: true });
  backToTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

  // Animasi saat elemen muncul di layar.
  const revealElements = document.querySelectorAll(".section-title, .section-intro, .event-card, .soft-card, .location-card, .gallery-item, .rsvp-form");
  revealElements.forEach((element) => element.classList.add("reveal"));
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  revealElements.forEach((element) => revealObserver.observe(element));

  // Galeri: tampilkan foto pada Bootstrap Modal.
  const galleryModalElement = document.getElementById("galleryModal");
  const galleryModal = new bootstrap.Modal(galleryModalElement);
  document.querySelectorAll(".gallery-item").forEach((button) => {
    button.addEventListener("click", () => {
      const image = document.getElementById("modalGalleryImage");
      image.src = button.dataset.image;
      image.alt = button.dataset.caption || "Foto galeri pernikahan";
      document.getElementById("modalGalleryCaption").textContent = button.dataset.caption || "";
      galleryModal.show();
    });
  });
  galleryModalElement.addEventListener("hidden.bs.modal", () => {
    document.getElementById("modalGalleryImage").src = "";
  });

  // RSVP demo: validasi dan tampilkan ringkasan lokal. Belum mengirim data ke server.
  const rsvpForm = document.getElementById("rsvpForm");
  const rsvpAlert = document.getElementById("rsvpAlert");
  rsvpForm.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    rsvpForm.classList.add("was-validated");

    if (!rsvpForm.checkValidity()) {
      rsvpAlert.className = "alert alert-warning mt-3";
      rsvpAlert.textContent = "Mohon lengkapi nama, jumlah tamu, dan status kehadiran terlebih dahulu.";
      return;
    }

    const name = document.getElementById("guestName").value.trim();
    const count = document.getElementById("guestCount").value;
    const attendance = document.getElementById("attendance").value;
    const message = document.getElementById("guestMessage").value.trim();

    if (!name) {
      document.getElementById("guestName").focus();
      return;
    }

    rsvpAlert.className = "alert alert-success mt-3";
    rsvpAlert.textContent = `Terima kasih, ${name}. Konfirmasi "${attendance}" untuk ${count} tamu berhasil diproses di halaman ini.${message ? " Ucapan Anda juga sudah tercatat sementara di tampilan ini." : ""} Catatan: data belum dikirim ke server.`;
    rsvpAlert.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  updateMusicButton();
});
