/* =========================
  文字ゼロ版：背景色が問題
  - 上に4つの丸スロット（正解を並べる）
  - 盤面は散らし配置（重なり/近すぎを回避）
  - pointerdown統一 + 連打ロック + 即disabled
  - 8色（各ステージ4択）+ 虹ステージ
  - リスタート無し：詰み防止で自動補充（A案）
========================= */

const CHOICES_PER_STAGE = 4;     // 4択（コメント通り）
const NEED_CORRECT = 4;          // スロット4つ埋めたら次へ
const BUSY_MS = 120;             // 連打ロック
const RAINBOW_STAGE = true;
const RAINBOW_COUNT = 1;

// 「詰み防止」：盤面に残る押せる絵文字がこれ以下になったら自動補充
const RESHUFFLE_WHEN_LEFT = 4;

// 近すぎ判定（3歳フィルタ）
const NEAR_MARGIN = 12;

// 表示数（SE考慮なしでOK）
function getMaxTilesByScreen() {
  const w = window.innerWidth;
  return 32;
}

const COLORS = [
  { id:"red",    hex:"#ff3b30", emojis:["🍎","🍓","📮","🌹"] },
  { id:"blue",   hex:"#0a84ff", emojis:["🐳","🐬","🌍","🚙"] },
  { id:"yellow", hex:"#ffd60a", emojis:["🐝","🌻","🍋","🧀"] },
  { id:"green",  hex:"#34c759", emojis:["🦖","🥦","🥝","🐸"] },
  { id:"purple", hex:"#782aa0ff", emojis:["🍇","🍆","💜","☂️"] },
  { id:"orange", hex:"#ff6a00", emojis:["🍊","🦊","🎃","🥕"] },
  { id:"pink",   hex:"#ff97aaff", emojis:["🌸","🎀","🍧","🦩"] },
  { id:"brown",  hex:"#70331cff", emojis:["🐿","🌰","🧸","🥔"] },
];

const el = {
  slots: document.getElementById("slots"),
  board: document.getElementById("board"),
  toast: document.getElementById("toast"),
};

let stageIndex = 0;
let correctInStage = 0;
let isBusy = false;

let currentTarget = null;    // COLORS[stageIndex] or rainbow
let currentChoices = [];     // 4色
let tiles = [];              // 盤面タイル

// ---- 音（外部ファイル不要） ----
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(()=>{});
}
function beep({ freq=880, dur=0.08, type="sine", gain=0.05 }) {
  ensureAudio();
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}
const sfxPing = () => { beep({freq:880, dur:0.08, type:"triangle", gain:0.06}); beep({freq:1320, dur:0.06, type:"triangle", gain:0.045}); };
const sfxBoo  = () => { beep({freq:220, dur:0.12, type:"sawtooth", gain:0.05}); };
const sfxWin  = () => { beep({freq:660, dur:0.09, type:"square", gain:0.05}); beep({freq:880, dur:0.09, type:"square", gain:0.05}); beep({freq:1320, dur:0.11, type:"square", gain:0.05}); };

// ---- 効果音ファイル（ごほうび用） ----
const sfxFiles = {
  clear: new Audio("./sounds/stage-clear.mp3"),
  rainbow: new Audio("./sounds/rainbow.mp3"),
};

// 初期設定
Object.values(sfxFiles).forEach(a => {
  a.preload = "auto";
  a.volume = 0.85;   // 子ども向けでちょい丸め
});
function playFileSound(name){
  const a = sfxFiles[name];
  if (!a) return;
  a.currentTime = 0;
  a.play().catch(()=>{});
}

// ---- util ----
function shuffle(arr){
  const a = arr.slice();
  for (let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
function sample(arr, n){ return shuffle(arr).slice(0, n); }

function toast(msg){
  if (!el.toast) return;
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(()=> el.toast.classList.remove("show"), 900);
}

// ---- UI: 問題色（画面全体） ----
function applyQuestionColor(hex){
  document.body.classList.remove("rainbow");
  document.documentElement.style.setProperty("--questionSolid", hex);
}



// ---- 上のスロット（4つ） ----
function resetSlots(){
  correctInStage = 0;
  [...el.slots.querySelectorAll(".slot")].forEach(s => { s.textContent = ""; });
}
function fillNextSlot(emoji){
  const slot = el.slots.querySelector(`.slot[data-slot="${correctInStage}"]`);
  if (!slot) return;
  slot.textContent = emoji;
  // ポン演出（CSSにslot.popがあれば効く）
  slot.classList.remove("pop");
  void slot.offsetWidth;
  slot.classList.add("pop");
}

// ---- ステージ: 4択作り ----
function buildChoicesForTarget(target){
  const others = COLORS.filter(c => c.id !== target.id);
  const picks = sample(others, CHOICES_PER_STAGE - 1);
  return shuffle([target, ...picks]);
}

function buildTilesForChoices(choices){
  // choicesの全絵文字をユニークで集める
  const pool = [];
  const seen = new Set();

  for (const c of choices){
    for (const e of c.emojis){
      const key = `${c.id}:${e}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push({ emoji:e, colorId:c.id, special:"" });
    }
  }

  // 端末に応じて表示上限（iPhoneは押しやすさ優先 / iPadは多め）
  const MAX_TILES = getMaxTilesByScreen();
  return shuffle(pool).slice(0, Math.min(MAX_TILES, pool.length));
}

function buildRainbowTiles(){
  // 全色プール + 🌈を混ぜる（ここは“祭り”）
  const pool = [];
  const seen = new Set();
  for (const c of COLORS){
    for (const e of c.emojis){
      const key = `${c.id}:${e}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push({ emoji:e, colorId:c.id, special:"" });
    }
  }

  const MAX_TILES = getMaxTilesByScreen();
  const picked = shuffle(pool).slice(0, Math.min(MAX_TILES - RAINBOW_COUNT, pool.length));

  for (let i=0;i<RAINBOW_COUNT;i++){
    picked.push({ emoji:"🌈", colorId:"rainbow", special:"rainbow" });
  }
  return shuffle(picked);
}

// ---- 盤面描画（散らし + 近すぎ解消） ----
function getRect(btn){
  const x = parseFloat(btn.style.left) || 0;
  const y = parseFloat(btn.style.top) || 0;
  const s = parseFloat(getComputedStyle(btn).width) || 60;
  return { left:x, top:y, right:x+s, bottom:y+s };
}

function overlaps(a, b, margin = NEAR_MARGIN){
  return !(
    a.right <= b.left + margin ||
    a.left >= b.right - margin ||
    a.bottom <= b.top + margin ||
    a.top >= b.bottom - margin
  );
}

function tryRelocate(btn, others, boardW, boardH, tileSize, margin){
  const pad = 6;
  const maxX = Math.max(pad, boardW - tileSize - pad);
  const maxY = Math.max(pad, boardH - tileSize - pad);

  for (let k = 0; k < 500; k++){
    const x = pad + Math.random() * (maxX - pad);
    const y = pad + Math.random() * (maxY - pad);
    const r = { left:x, top:y, right:x+tileSize, bottom:y+tileSize };

    let hit = false;
    for (const o of others){
      if (o === btn) continue;
      const ro = getRect(o);
      if (overlaps(r, ro, margin)){ hit = true; break; }
    }
    if (!hit){
      btn.style.left = `${x}px`;
      btn.style.top  = `${y}px`;
      return true;
    }
  }
  return false;
}

function resolveOverlaps(buttons, boardW, boardH, tileSize){
  const MARGIN = NEAR_MARGIN;

  for (let pass = 0; pass < 5; pass++){
    let moved = 0;

    for (let i = 0; i < buttons.length; i++){
      for (let j = i + 1; j < buttons.length; j++){
        const a = getRect(buttons[i]);
        const b = getRect(buttons[j]);

        if (overlaps(a, b, MARGIN)){
          if (tryRelocate(buttons[j], buttons, boardW, boardH, tileSize, MARGIN)){
            moved++;
          }
        }
      }
    }
    if (moved === 0) break;
  }
}

function renderBoard(){
  el.board.innerHTML = "";
  const frag = document.createDocumentFragment();

  const boardRect = el.board.getBoundingClientRect();
  const count = tiles.length;

  // タイルサイズ：数が多いほど小さく。最低40は死守
  const area = boardRect.width * boardRect.height;
  const approx = Math.floor(Math.sqrt(area / Math.max(count, 1)) * 0.85);
  const tileSize = Math.max(40, Math.min(96, approx));
  document.documentElement.style.setProperty("--tileSize", `${tileSize}px`);

  // まずランダムに置く（近すぎは後でほどく）
  const pad = 6;
  const maxX = Math.max(pad, boardRect.width  - tileSize - pad);
  const maxY = Math.max(pad, boardRect.height - tileSize - pad);

  tiles.forEach((t, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "emoji-btn";
    btn.textContent = t.emoji;

    btn.dataset.index = String(idx);
    btn.dataset.color = t.colorId;
    btn.dataset.special = t.special || "";
    btn.dataset.disabled = "0";

    btn.addEventListener("pointerdown", onTilePointerDown, { passive:false });

    const x = pad + Math.random() * (maxX - pad);
    const y = pad + Math.random() * (maxY - pad);
    btn.style.left = `${x}px`;
    btn.style.top  = `${y}px`;

    frag.appendChild(btn);
  });

  el.board.appendChild(frag);

  const btns = [...el.board.querySelectorAll(".emoji-btn")];
  resolveOverlaps(btns, boardRect.width, boardRect.height, tileSize);
}

// ---- 入力処理（長押し/連打対策） ----
function lockShort(){
  isBusy = true;
  window.setTimeout(()=> { isBusy = false; }, BUSY_MS);
}
function disableButton(btn){
  btn.dataset.disabled = "1";
  btn.classList.add("disabled");
}

function onTilePointerDown(e){
  e.preventDefault();

  const btn = e.currentTarget;
  if (isBusy) return;
  if (btn.dataset.disabled === "1") return;

  lockShort();
  disableButton(btn);

  // 虹ステージ
  if (btn.dataset.special === "rainbow"){
    sparkleSlots(); 
    playFileSound("rainbow");   // ★追加
    fillNextSlot("🌈");
    window.setTimeout(()=> restartGame(), 900);
    return;
  }


  const chosenColor = btn.dataset.color;
  const isCorrect = chosenColor === currentTarget.id;

  if (isCorrect){
    sfxPing();
    fillNextSlot(btn.textContent);
    correctInStage++;

    if (correctInStage >= NEED_CORRECT){
      playClearRing();          // ★丸つけ演出
      playFileSound("clear");   // ★クリア音
      nextStage();
      return;
    }

  } else {
    sfxBoo();
  }

  // ✅ A案：詰み防止（残りが少なくなったら自動補充）
  const remaining = el.board.querySelectorAll(".emoji-btn:not(.disabled)").length;
  if (remaining <= RESHUFFLE_WHEN_LEFT) {
    window.setTimeout(() => reshuffleCurrent(), 120);
  }
}

// ---- 進行 ----
function startStage(i){
  stageIndex = i;
  currentTarget = COLORS[stageIndex];
  currentChoices = buildChoicesForTarget(currentTarget);
  tiles = buildTilesForChoices(currentChoices);

  resetSlots();
  applyQuestionColor(currentTarget.hex);
  renderBoard();
}

function startRainbowStage(){
  currentTarget = { id:"rainbow" };
  currentChoices = [];
  tiles = buildRainbowTiles();

  resetSlots(); // 後で “虹ステージはスロット非表示” にするので、この行は残してOK
  document.body.classList.add("rainbow");
  renderBoard();

}

function nextStage(){
  if (stageIndex < COLORS.length - 1){
    startStage(stageIndex + 1);
  } else {
    if (RAINBOW_STAGE) startRainbowStage();
    else { sfxWin(); restartGame(); }
  }
}

function reshuffleCurrent(){
  if (currentTarget?.id === "rainbow"){
    tiles = buildRainbowTiles();
  } else {
    tiles = buildTilesForChoices(currentChoices);
  }
  renderBoard();
}

function restartGame(){
  startStage(0);
}

// 画面回転/サイズ変化で詰まりやすいので、再配置だけかける（やさしめ）
window.addEventListener("resize", () => {
  if (!tiles.length) return;
  renderBoard();
});

// ---- PWA ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(()=>{});
  });
}
function playClearRing(){
  const slots = el.slots;
  if (!slots) return;
  slots.classList.remove("ring");
  void slots.offsetWidth; // リスタート
  slots.classList.add("ring");
}
function sparkleSlots(){
  const slots = el.slots;
  if (!slots) return;
  slots.classList.remove("sparkle");
  void slots.offsetWidth; // アニメを毎回発火させる
  slots.classList.add("sparkle");
}

// start
restartGame();
