import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { XREstimatedLight } from 'three/addons/webxr/XREstimatedLight.js';

// ==========================================
// 定数・設定
// ==========================================
const FURNITURE_DATA = [
    { name: 'イス（フォトグラメトリ）',   file: 'photographchair_最新版.glb',     height: 0.79, category: 'チェア', placement: 'floor'},
    { name: 'イス（生成AI）',   file: 'AIイス.glb',     height: 0.79, category: 'チェア', placement: 'floor'},
    { name: 'イス（実験用）',   file: 'photograph_and_AIchair_最新版.glb', height: 0.79, category: 'チェア', placement: 'floor'}, 
    { name: 'パイプイス',   file: 'base_basic_chair.glb',     height: 0.79, category: 'チェア', placement: 'floor'},
    { name: '木製イス',   file: 'base_basic_woodchair.glb',     height: 0.81, category: 'チェア', placement: 'floor'},
    { name: '本棚',   file: 'base_basic_book.glb', height: 0.94, category: '収納', placement: 'floor'},
    { name: '机',   file: 'base_basic_table.glb',     height: 0.79, category: 'テーブル', placement: 'floor'},
];

// アプリケーションの状態管理
const APP_STATE = {
    IDLE: 'IDLE',       // 待機中（家具選択待ち）
    PLACING: 'PLACING', // 新規家具の配置場所選定中
    EDITING: 'EDITING'  // 既存家具の編集（移動・回転・削除）中
};

// ==========================================
// グローバル変数
// ==========================================
let container, camera, scene, renderer;
let reticle, hitTestSource = null, hitTestSourceRequested = false;
let crossMark; // 配置不可マーク
let currentAppState = APP_STATE.IDLE;
let isEditMode = true; // 編集モードか鑑賞モードか
let isFloorDetected = false;

// 3Dオブジェクト関連
const loader = new GLTFLoader();
const preloadedModels = new Map(); // キャッシュ用
const placedObjects = []; // 配置済み家具リスト
let previewObject = null; // 配置中の半透明オブジェクト
let selectedObject = null; // 編集中のオブジェクト
let hoveredObject = null; // 視線（レティクル）が合っているオブジェクト
let currentFurnitureData = null; // 現在選択中の家具データ

// ジェスチャー操作用
const gestureState = {
    touchCount: 0,
    initialDistance: 0,
    lastX: 0,
    startX: 0,
    startY: 0,
    startTime: 0,
    isInteracting: false,
    originalMultiplier: 1.0,
    longPressTimer: null
};

// UI・アニメーション関連
const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
let dotAnimationTimer = null;
const objectsToDelete = []; // 削除アニメーション用キュー
let isRotatingContinuously = false;
let continuousRotationDirection = 0;

// UI要素のキャッシュ
const ui = {};

// ==========================================
// 初期化・メインループ
// ==========================================

init();

function init() {
    // UI要素の取得
    cacheUIElements();
    
    // シーンセットアップ
    scene = new THREE.Scene();
    
    // 【変更】デフォルトのライトは、ARの推定が始まるまでの「仮」として定義
    // 変数名を const ではなく let にして、後で削除できるように参照を持っておく
    let defaultLight = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1.0); // 最初は少し暗めに
    scene.add(defaultLight);

    // カメラ設定
    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

    // レンダラー設定
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    document.body.appendChild(renderer.domElement);

    // 【追加】環境光推定のセットアップ
    const xrLight = new XREstimatedLight(renderer);
    
    // 推定が開始されたら（ARモードに入って光を検知したら）
    xrLight.addEventListener('estimationstart', () => {
        scene.add(xrLight);           // 推定ライトを追加
        scene.remove(defaultLight);   // 仮のライトを削除
        scene.environment = xrLight.environment; // 金属の反射などにも適用
    });

    // 推定が終了したら（AR終了時など）
    xrLight.addEventListener('estimationend', () => {
        scene.remove(xrLight);
        scene.add(defaultLight);
        scene.environment = null;
    });

    // ARボタン配置
    const arButton = ARButton.createButton(renderer, {
        requiredFeatures: ['hit-test', 'light-estimation'],
        optionalFeatures: ['dom-overlay', 'plane-detection'], // 【変更】'plane-detection'を追加
        domOverlay: { root: document.querySelector("#overlay") }
    });
    document.body.appendChild(arButton);

    // レティクル（カーソル）作成
    reticle = new THREE.Mesh(
        new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial()
    );
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);

    // ❌マーク作成
    crossMark = createCrossMark();
    scene.add(crossMark);

    // イベントリスナー設定
    setupEventListeners();

    // WebXRセッションイベント
    renderer.xr.addEventListener('sessionstart', onSessionStart);
    renderer.xr.addEventListener('sessionend', onSessionEnd);

    // アニメーション開始
    renderer.setAnimationLoop(render);

    // モデルのプリロード開始
    preloadModels();
}

function cacheUIElements() {
    const ids = [
        'overlay', 'title-container', 'instruction-text', 'loading-dots',
        'mode-switch-button', 'edit-mode-label', 'view-mode-label',
        'help-button', 'exit-ar-button', 'help-modal', 'close-help-button',
        'add-button', 'edit-button', 'transform-controls', 'decision-controls',
        'scale-slider-container', 'slider-track', 'slider-handle',
        'rotate-left-button', 'rotate-right-button', 'delete-button', 'confirm-button',
        'confirm-dialog', 'confirm-delete-yes', 'confirm-delete-no',
        'furniture-modal', 'furniture-modal-inner', 'close-modal-button',
        'search-input', 'clear-search-button', 'category-tabs', 'furniture-grid'
    ];
    ids.forEach(id => { ui[id] = document.getElementById(id); });
}

function onSessionStart() {
    ui['title-container'].style.display = 'none';
    resetScene();
    isEditMode = true;
    
    ui['instruction-text'].style.display = 'block';
    startDotAnimation();

    updateUI();
}

function onSessionEnd() {
    ui['title-container'].style.display = 'block';
    resetScene();
    ui['exit-ar-button'].style.display = 'none';
    ui['help-button'].style.display = 'none';
    ui['mode-switch-button'].style.display = 'none';
    
    ui['instruction-text'].style.display = 'none';
    stopDotAnimation();
}

function resetScene() {
    placedObjects.forEach(obj => scene.remove(obj));
    placedObjects.length = 0;
    if (previewObject) {
        scene.remove(previewObject);
        previewObject = null;
    }
    selectedObject = null;
    hoveredObject = null;
    currentAppState = APP_STATE.IDLE;
    isFloorDetected = false;
    hitTestSource = null;
    hitTestSourceRequested = false;
    reticle.visible = false;
    updateUI();
}

function createCrossMark() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = 'rgba(204, 0, 0, 0.8)';
    ctx.beginPath();
    ctx.arc(128, 128, 128, 0, 2 * Math.PI);
    ctx.fill();
    
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 25;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(64, 64);
    ctx.lineTo(192, 192);
    ctx.moveTo(192, 64);
    ctx.lineTo(64, 192);
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false })
    );
    plane.renderOrder = 999;
    plane.visible = false;
    plane.rotation.x = -Math.PI / 2;
    return plane;
}

function preloadModels() {
    const promises = FURNITURE_DATA.map(item => {
        return new Promise((resolve, reject) => {
            loader.load(item.file, (gltf) => {
                preloadedModels.set(item.file, gltf);
                resolve();
            }, undefined, (err) => {
                console.warn(`Failed to load ${item.file}`, err);
                resolve();
            });
        });
    });
    Promise.all(promises).then(() => console.log('All models preloaded'));
}


// ==========================================
// イベントハンドリング
// ==========================================

function setupEventListeners() {
    ui['overlay'].addEventListener('touchstart', handleTouchStart, { passive: false });
    ui['overlay'].addEventListener('touchmove', handleTouchMove, { passive: false });
    ui['overlay'].addEventListener('touchend', handleTouchEnd);

    ui['exit-ar-button'].addEventListener('click', (e) => {
        e.stopPropagation();
        const session = renderer.xr.getSession();
        if (session) session.end();
    });

    ui['mode-switch-button'].addEventListener('click', toggleMode);

    ui['add-button'].addEventListener('click', openFurnitureModal);
    ui['edit-button'].addEventListener('click', startEditingHoveredObject);

    ui['confirm-button'].addEventListener('click', confirmPlacement);
    ui['delete-button'].addEventListener('click', requestDeleteObject);

    setupRotationButton(ui['rotate-left-button'], 1);
    setupRotationButton(ui['rotate-right-button'], -1);

    setupSlider();

    setupModalEvents();

    ui['help-button'].addEventListener('click', () => ui['help-modal'].style.display = 'flex');
    ui['close-help-button'].addEventListener('click', () => ui['help-modal'].style.display = 'none');
    
    document.querySelectorAll('.help-tab-button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.help-tab-button').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.help-page').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
        });
    });

    ui['confirm-delete-yes'].addEventListener('click', executeDelete);
    ui['confirm-delete-no'].addEventListener('click', () => {
        ui['confirm-dialog'].style.display = 'none';
        gestureState.objectPendingDeletion = null;
    });

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        adjustModalForKeyboard();
    });
}

function handleTouchStart(event) {
    if (event.target !== event.currentTarget || ui['confirm-dialog'].style.display === 'flex') return;
    event.preventDefault();

    gestureState.touchCount = event.touches.length;
    gestureState.startTime = Date.now();
    gestureState.startX = event.touches[0].clientX;
    gestureState.startY = event.touches[0].clientY;

    const activeObject = getActiveObject();

    if (gestureState.touchCount === 1 && isEditMode) {
        clearTimeout(gestureState.longPressTimer);
        gestureState.longPressTimer = setTimeout(() => {
            handleLongPress(event.touches[0]);
        }, 800);
    }

    if (gestureState.touchCount === 1) {
        gestureState.lastX = event.touches[0].clientX;
    } else if (gestureState.touchCount >= 2 && activeObject) {
        clearTimeout(gestureState.longPressTimer);
        gestureState.initialDistance = getDistance(event.touches);
        gestureState.originalMultiplier = activeObject.userData.scaleMultiplier || 1.0;
        gestureState.isInteracting = true;
    }
}

function handleTouchMove(event) {
    if (event.target !== event.currentTarget || ui['confirm-dialog'].style.display === 'flex') return;
    event.preventDefault();

    if (gestureState.longPressTimer) {
        const moveX = event.touches[0].clientX;
        const moveY = event.touches[0].clientY;
        const dist = Math.hypot(moveX - gestureState.startX, moveY - gestureState.startY);
        if (dist > 10) clearTimeout(gestureState.longPressTimer);
    }

    const activeObject = getActiveObject();
    if (!activeObject || !isEditMode) return;

    if (gestureState.touchCount === 1 && event.touches.length === 1) {
        gestureState.isInteracting = true; 
        const currentX = event.touches[0].clientX;
        const deltaX = currentX - gestureState.lastX;
        activeObject.rotation.y += deltaX * 0.01;
        gestureState.lastX = currentX;
    }
    else if (gestureState.touchCount >= 2 && event.touches.length >= 2 && gestureState.initialDistance > 0) {
        gestureState.isInteracting = true;
        const currentDist = getDistance(event.touches);
        const ratio = currentDist / gestureState.initialDistance;
        let newMult = gestureState.originalMultiplier * ratio;
        newMult = Math.max(0.5, Math.min(2.0, newMult)); 

        applyScale(activeObject, newMult);
    }
}

function handleTouchEnd(event) {
    if (event.target !== event.currentTarget) return;

    const wasLongPress = !gestureState.longPressTimer && (Date.now() - gestureState.startTime >= 800);
    clearTimeout(gestureState.longPressTimer);
    gestureState.longPressTimer = null;

    const touchDuration = Date.now() - gestureState.startTime;
    const distMoved = Math.hypot(
        event.changedTouches[0].clientX - gestureState.startX,
        event.changedTouches[0].clientY - gestureState.startY
    );

    if (!wasLongPress && touchDuration < 200 && distMoved < 10) {
        onTap(event.changedTouches[0]);
    }

    if (event.touches.length === 0) {
        gestureState.isInteracting = false;
    }
    if (event.touches.length > 0 && event.touches.length !== gestureState.touchCount) {
        handleTouchStart(event);
    }
    gestureState.touchCount = event.touches.length;
}

function getDistance(touches) {
    return Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY
    );
}

function handleLongPress(touch) {
    const target = raycast(touch.clientX, touch.clientY);
    if (target) {
        const activeObject = getActiveObject();
        if (target === activeObject || placedObjects.includes(target)) {
            gestureState.objectPendingDeletion = target;
            ui['confirm-dialog'].style.display = 'flex';
        }
    }
}

function onTap(touch) {
    const target = raycast(touch.clientX, touch.clientY);
    
    const activeObject = getActiveObject();
    // 配置/編集モード中に自分のオブジェクトをタップ -> 確定
    if (activeObject && target === activeObject) {
        confirmPlacement();
        return;
    }

    // IDLEモード中に配置済みオブジェクトをタップ -> 編集開始
    if (currentAppState === APP_STATE.IDLE && isEditMode && target) {
        let obj = target;
        while (obj.parent && !placedObjects.includes(obj)) {
            obj = obj.parent;
        }
        if (placedObjects.includes(obj)) {
            selectObjectForEditing(obj);
        }
        return; // ここで処理終了
    }

    // 【追加】編集中に何もないところ（床など）をタップ -> 選択解除
    if (currentAppState === APP_STATE.EDITING && !target) {
        deselectObject();
    }
}

function raycast(clientX, clientY) {
    const x = (clientX / window.innerWidth) * 2 - 1;
    const y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera({ x, y }, camera);

    let candidates = placedObjects;
    if (previewObject) candidates = candidates.concat([previewObject]);
    if (selectedObject && !candidates.includes(selectedObject)) candidates = candidates.concat([selectedObject]);

    const intersects = raycaster.intersectObjects(candidates, true);
    if (intersects.length > 0) {
        let obj = intersects[0].object;
        while(obj.parent && obj.parent.type !== 'Scene') {
             if (candidates.includes(obj)) return obj;
             obj = obj.parent;
        }
        return obj;
    }
    return null;
}


// ==========================================
// アプリロジック (3D操作)
// ==========================================

function getActiveObject() {
    return currentAppState === APP_STATE.PLACING ? previewObject : selectedObject;
}

function toggleMode(e) {
    e.stopPropagation();
    if (currentAppState !== APP_STATE.IDLE) return;
    
    isEditMode = !isEditMode;
    if (!isEditMode) {
        deselectObject();
    }
    updateUI();
}

function startEditingHoveredObject(e) {
    e.stopPropagation();
    if (hoveredObject) selectObjectForEditing(hoveredObject);
}

function selectObjectForEditing(obj) {
    if (!isEditMode) return;
    
    if (selectedObject) setObjectTransparency(selectedObject, false);

    selectedObject = obj;
    setObjectTransparency(selectedObject, true); 
    currentAppState = APP_STATE.EDITING;
    
    const percent = ((selectedObject.userData.scaleMultiplier || 1.0) - 0.5) / 1.5;
    updateSliderHandle(percent);
    
    hoveredObject = null;
    updateUI();
}

function deselectObject() {
    if (selectedObject) {
        setObjectTransparency(selectedObject, false);
        selectedObject = null;
    }
    if (previewObject) {
        scene.remove(previewObject);
        previewObject = null;
    }
    currentAppState = APP_STATE.IDLE;
    updateUI();
}

function confirmPlacement() {
    if (currentAppState === APP_STATE.PLACING && previewObject) {
        const solid = previewObject.clone();
        setObjectTransparency(solid, false);
        solid.userData = JSON.parse(JSON.stringify(previewObject.userData));
        scene.add(solid);
        placedObjects.push(solid);
        
        scene.remove(previewObject);
        previewObject = null;
    } else if (currentAppState === APP_STATE.EDITING && selectedObject) {
        setObjectTransparency(selectedObject, false);
        selectedObject = null;
    }
    currentAppState = APP_STATE.IDLE;
    updateUI();
}

function requestDeleteObject(e) {
    e.stopPropagation();
    const target = getActiveObject();
    if (target) {
        gestureState.objectPendingDeletion = target;
        ui['confirm-dialog'].style.display = 'flex';
    }
}

function executeDelete() {
    const target = gestureState.objectPendingDeletion;
    if (!target) return;

    ui['confirm-dialog'].style.display = 'none';

    const idx = placedObjects.indexOf(target);
    if (idx > -1) placedObjects.splice(idx, 1);

    objectsToDelete.push({
        object: target,
        startTime: clock.getElapsedTime(),
        duration: 0.3,
        initialY: target.position.y
    });

    if (target === selectedObject || target === previewObject) {
        selectedObject = null;
        previewObject = null;
        currentAppState = APP_STATE.IDLE;
        updateUI();
    }
    gestureState.objectPendingDeletion = null;
}

function applyScale(object, multiplier) {
    object.userData.scaleMultiplier = multiplier;
    object.scale.copy(object.userData.initialScale).multiplyScalar(multiplier);
    const percent = (multiplier - 0.5) / 1.5;
    updateSliderHandle(percent);
}

function setObjectTransparency(obj, transparent, opacity = 0.7) {
    obj.traverse(child => {
        if (child.isMesh) {
            child.material.transparent = transparent;
            child.material.opacity = transparent ? opacity : 1.0;
            child.material.depthWrite = !transparent; 
            child.material.needsUpdate = true;
        }
    });
}

function setupRotationButton(btn, dir) {
    let timer;
    const start = (e) => {
        e.preventDefault();
        timer = setTimeout(() => {
            isRotatingContinuously = true;
            continuousRotationDirection = dir;
        }, 300);
    };
    const end = (e) => {
        e.preventDefault();
        clearTimeout(timer);
        if (!isRotatingContinuously) {
            const target = getActiveObject();
            if (target) target.rotation.y += (Math.PI / 4) * dir;
        }
        isRotatingContinuously = false;
    };
    btn.addEventListener('touchstart', start, { passive: false });
    btn.addEventListener('touchend', end);
    btn.addEventListener('mousedown', start);
    btn.addEventListener('mouseup', end);
}

// ==========================================
// スライダーUIロジック
// ==========================================
function setupSlider() {
    let isDragging = false;
    const handle = ui['slider-handle'];
    const track = ui['slider-track'];

    const onMove = (clientX) => {
        if (!isDragging) return;
        const rect = track.getBoundingClientRect();
        let percent = (clientX - rect.left) / rect.width;
        percent = Math.max(0, Math.min(1, percent));
        
        updateSliderHandle(percent);
        
        const activeObject = getActiveObject();
        if (activeObject) {
            const multiplier = 0.5 + percent * 1.5; 
            applyScale(activeObject, multiplier);
        }
    };

    const start = (e) => { e.stopPropagation(); isDragging = true; };
    const end = () => { isDragging = false; };
    const moveTouch = (e) => { if(isDragging) e.preventDefault(); onMove(e.touches[0].clientX); };
    const moveMouse = (e) => { if(isDragging) e.preventDefault(); onMove(e.clientX); };

    handle.addEventListener('mousedown', start);
    document.addEventListener('mousemove', moveMouse);
    document.addEventListener('mouseup', end);

    handle.addEventListener('touchstart', start, { passive: false });
    document.addEventListener('touchmove', moveTouch, { passive: false });
    document.addEventListener('touchend', end);
}

function updateSliderHandle(percent) {
    percent = Math.max(0, Math.min(1, percent));
    const handle = ui['slider-handle'];
    const handleW = handle.offsetWidth;
    handle.style.left = `calc(${percent * 100}% - ${handleW * percent}px)`;
    const scale = 0.8 + 0.4 * percent;
    handle.style.transform = `translateY(-50%) scale(${scale})`;
}


// ==========================================
// 家具モーダル & 検索
// ==========================================

function openFurnitureModal(e) {
    e.stopPropagation();
    if (currentAppState !== APP_STATE.IDLE) return;
    
    ui['furniture-modal'].style.display = 'flex';
    generateCategoryTabs();
    ui['search-input'].value = '';
    ui['clear-search-button'].style.display = 'none';
    
    // 【修正】モーダル表示時にフォーカスしない（キーボードを出さない）
    // ui['search-input'].focus(); // 削除
}

function closeModal() {
    ui['furniture-modal'].style.display = 'none';
    ui['search-input'].blur();
}

function setupModalEvents() {
    ui['close-modal-button'].addEventListener('click', closeModal);
    ui['furniture-modal'].addEventListener('click', (e) => {
        if (e.target === ui['furniture-modal']) closeModal();
    });

    ui['search-input'].addEventListener('input', (e) => {
        const val = e.target.value;
        ui['clear-search-button'].style.display = val ? 'block' : 'none';
        const activeCat = document.querySelector('.category-tab-button.active')?.dataset.category || 'すべて';
        renderFurnitureGrid(activeCat, val);
    });

    ui['clear-search-button'].addEventListener('click', () => {
        ui['search-input'].value = '';
        ui['clear-search-button'].style.display = 'none';
        const activeCat = document.querySelector('.category-tab-button.active')?.dataset.category || 'すべて';
        renderFurnitureGrid(activeCat, '');
        ui['search-input'].focus();
    });
    
    setupModalSwipe();
}

function generateCategoryTabs() {
    const categories = ['すべて', ...new Set(FURNITURE_DATA.map(d => d.category))];
    const container = ui['category-tabs'];
    container.innerHTML = '';

    categories.forEach((cat, index) => {
        const btn = document.createElement('button');
        btn.className = 'category-tab-button';
        if (index === 0) btn.classList.add('active');
        btn.textContent = cat;
        btn.dataset.category = cat;
        btn.addEventListener('click', () => {
            document.querySelectorAll('.category-tab-button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderFurnitureGrid(cat, ui['search-input'].value);
        });
        container.appendChild(btn);
    });
    
    renderFurnitureGrid('すべて', '');
}

function renderFurnitureGrid(category, searchText) {
    const grid = ui['furniture-grid'];
    grid.innerHTML = '';
    
    const term = searchText.toLowerCase().trim();
    
    const filtered = FURNITURE_DATA.filter(item => {
        const matchCat = category === 'すべて' || item.category === category;
        const matchSearch = item.name.toLowerCase().includes(term);
        return matchCat && matchSearch;
    });

    if (filtered.length === 0) {
        grid.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: #aaa;">該当なし</p>';
        return;
    }

    filtered.forEach(item => {
        const div = document.createElement('div');
        div.className = 'grid-item';
        
        const img = document.createElement('img');
        img.src = item.thumbnail;
        img.onerror = () => { img.style.display = 'none'; }; 
        
        const p = document.createElement('p');
        p.textContent = item.name;

        div.appendChild(img);
        div.appendChild(p);

        div.addEventListener('click', (e) => {
            e.stopPropagation();
            startPlacingFurniture(item);
        });
        grid.appendChild(div);
    });
}

function setupModalSwipe() {
    let startX = 0;
    let startY = 0;
    let isHorizontalDrag = null; // null:未判定, true:横移動(スワイプ), false:縦移動(スクロール)
    const content = ui['furniture-modal-inner'];
    
    // touchstart: 開始位置を記録し、判定フラグをリセット
    content.addEventListener('touchstart', (e) => {
        if (e.target.closest('.category-tab-button') || e.target.closest('#search-input')) return;
        
        const touch = e.changedTouches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        isHorizontalDrag = null; // 判定リセット
    }, { passive: true });

    // touchmove: 方向を判定し、横移動ならスクロールを止める
    content.addEventListener('touchmove', (e) => {
        if (e.target.closest('.category-tab-button') || e.target.closest('#search-input')) return;
        
        // すでに縦スクロールと判定されていたら何もしない（ブラウザのスクロールに任せる）
        if (isHorizontalDrag === false) return;

        const touch = e.changedTouches[0];
        const diffX = Math.abs(touch.clientX - startX);
        const diffY = Math.abs(touch.clientY - startY);

        // まだ判定されていない、かつ一定距離動いた場合
        if (isHorizontalDrag === null && (diffX > 5 || diffY > 5)) {
            if (diffX > diffY) {
                // 横移動の方が大きい -> スワイプとみなす
                isHorizontalDrag = true;
            } else {
                // 縦移動の方が大きい -> スクロールとみなす
                isHorizontalDrag = false;
            }
        }

        // 横スワイプ判定なら、ブラウザの縦スクロールを無効化する
        if (isHorizontalDrag === true) {
            e.preventDefault(); 
        }
    }, { passive: false }); // preventDefaultを使うため passive: false

    // touchend: 横スワイプ判定だった場合のみタブを切り替える
    content.addEventListener('touchend', (e) => {
        if (e.target.closest('.category-tab-button') || e.target.closest('#search-input')) return;
        
        // 縦スクロール判定だった場合はタブ切り替えしない
        if (isHorizontalDrag === false) return;

        const endX = e.changedTouches[0].clientX;
        const diff = endX - startX;
        
        if (Math.abs(diff) > 50) {
            const tabs = Array.from(document.querySelectorAll('.category-tab-button'));
            const activeIdx = tabs.findIndex(t => t.classList.contains('active'));
            let nextIdx = activeIdx;
            
            if (diff < 0) nextIdx++; // 左スワイプ -> 次へ
            else nextIdx--;          // 右スワイプ -> 前へ
            
            // ループさせる
            if (nextIdx >= tabs.length) nextIdx = 0;
            if (nextIdx < 0) nextIdx = tabs.length - 1;
            
            tabs[nextIdx].click();
            tabs[nextIdx].scrollIntoView({ behavior: 'smooth', inline: 'center' });
        }
    }, { passive: true });
}

function adjustModalForKeyboard() {
    const modal = ui['furniture-modal'];
    const diff = window.innerHeight - document.documentElement.clientHeight;
    if (diff > 100) { 
        modal.classList.add('modal-above-keyboard');
        modal.style.setProperty('--keyboard-height', `${diff}px`);
    } else {
        modal.classList.remove('modal-above-keyboard');
        modal.style.removeProperty('--keyboard-height');
    }
}

function startPlacingFurniture(item) {
    currentFurnitureData = item;
    closeModal();
    
    const gltf = preloadedModels.get(item.file);
    if (!gltf) {
        alert('モデルを読み込み中です...');
        return;
    }
    
    if (previewObject) scene.remove(previewObject);
    
    previewObject = gltf.scene.clone();
    
    const box = new THREE.Box3().setFromObject(previewObject);
    const size = box.getSize(new THREE.Vector3());
    const scale = item.height / size.y;
    previewObject.scale.set(scale, scale, scale);
    
    previewObject.userData = {
        initialScale: new THREE.Vector3(scale, scale, scale),
        scaleMultiplier: 1.0,
        crossMarkScale: Math.max(size.x, size.z) * scale
    };
    
    setObjectTransparency(previewObject, true);
    scene.add(previewObject);
    
    currentAppState = APP_STATE.PLACING;
    
    updateSliderHandle(0.33); 
    updateUI();
}

// ==========================================
// レンダリングループ
// ==========================================

function render(timestamp, frame) {
    const delta = clock.getDelta();
    const elapsedTime = clock.getElapsedTime();

    // 削除アニメーション
    for (let i = objectsToDelete.length - 1; i >= 0; i--) {
        const item = objectsToDelete[i];
        const progress = (elapsedTime - item.startTime) / item.duration;
        if (progress < 1) {
            item.object.position.y = item.initialY + progress * 0.5; 
            setObjectTransparency(item.object, true, 1.0 - progress); 
        } else {
            scene.remove(item.object);
            objectsToDelete.splice(i, 1);
        }
    }

    if (!renderer.xr.isPresenting) return;

    if (isRotatingContinuously) {
        const target = getActiveObject();
        if (target) target.rotation.y += 0.04 * continuousRotationDirection;
    }

    handleReticleHover();

    if (frame) {
        const session = renderer.xr.getSession();
        
        if (!hitTestSourceRequested) {
            session.requestReferenceSpace('viewer').then(refSpace => {
                session.requestHitTestSource({ space: refSpace }).then(source => {
                    hitTestSource = source;
                });
            });
            hitTestSourceRequested = true;
        }

        if (hitTestSource) {
            const hitTestResults = frame.getHitTestResults(hitTestSource);
            
            if (hitTestResults.length > 0) {
                const hit = hitTestResults[0];
                const pose = hit.getPose(renderer.xr.getReferenceSpace());
                
                // ヒットした場所の姿勢（回転）を取得
                const hitMatrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
                const hitRotation = new THREE.Quaternion().setFromRotationMatrix(hitMatrix);
                
                // 面の向き（法線ベクトル）を計算
                // WebXRのヒットテストでは、Y軸(0,1,0)が面の法線方向になります
                const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(hitRotation);
                
                // 面が「水平」か「垂直」かを判定 (Y成分が1に近ければ床、0に近ければ壁)
                const isHorizontal = Math.abs(normal.y) > 0.8; 
                
                // 現在選択中の家具のタイプを取得 (未定義ならfloor)
                const placementType = currentFurnitureData ? (currentFurnitureData.placement || 'floor') : 'floor';
                
                // 配置条件チェック
                // 1. 床用家具かつ水平面
                // 2. 壁用家具かつ垂直面
                const isOrientationValid = (placementType === 'floor' && isHorizontal) || (placementType === 'wall' && !isHorizontal);

                // レティクルの表示と位置合わせ
                reticle.visible = isOrientationValid;
                if (isOrientationValid) {
                    reticle.matrix.fromArray(pose.transform.matrix);
                }
                
                if (!isFloorDetected) {
                    isFloorDetected = true;
                    updateUI();
                    stopDotAnimation();
                    ui['instruction-text'].style.display = 'none';
                }

                const activeObject = getActiveObject();
                if (activeObject && !gestureState.isInteracting && !isRotatingContinuously) {
                    
                    // 衝突判定
                    const isColliding = checkCollision(activeObject);
                    // 向きが合っていて、かつ衝突していない場合のみ配置可能
                    const canPlace = isOrientationValid && !isColliding; 
                    
                    if (canPlace) {
                        activeObject.visible = true;
                        
                        // 位置と向きの更新
                        activeObject.position.setFromMatrixPosition(reticle.matrix);
                        
                        if (placementType === 'wall') {
                            // 【壁用】壁の法線に向かってZ軸を合わせる（モデルの「背中」を壁に向ける）
                            // WebXRのヒットテストの回転をそのまま適用すると、Y軸が壁から飛び出す向きになることが多い
                            // モデルの前方(Z)を壁の法線(normal)に向けさせる
                            
                            // 壁に張り付く位置
                            activeObject.position.copy(reticle.position);
                            
                            // 壁の法線方向を向く回転を作成
                            const lookPos = activeObject.position.clone().add(normal);
                            activeObject.lookAt(lookPos);
                            
                        } else {
                            // 【床用】従来どおり（Y軸回転のみ保持したい場合はここで調整）
                            // ヒットテストの回転をそのまま使うと傾斜に合わせて傾く
                            activeObject.position.setFromMatrixPosition(reticle.matrix);
                            // 床置きの場合、Y軸回転（向き）はユーザー操作に任せ、傾きだけリセットするなどの調整も可能
                            // ここでは簡易的にレティクルの回転を適用し、ユーザー操作のY回転を加える実装になっている前提
                        }

                        crossMark.visible = false;
                        ui['confirm-button'].disabled = false;
                        ui['confirm-button'].style.opacity = '1';
                    } else {
                        // 配置不可（向きが違う or 衝突）
                        activeObject.visible = true; // バツ印の位置基準にするため表示はする
                        activeObject.position.setFromMatrixPosition(hitMatrix); // とりあえずその場に置く

                        reticle.visible = false;
                        crossMark.visible = true;
                        
                        crossMark.position.copy(activeObject.position);
                        
                        // バツ印を少し浮かせて、カメラに向ける
                        if (placementType === 'wall') {
                            crossMark.position.add(normal.clone().multiplyScalar(0.05)); // 壁から浮かす
                            crossMark.lookAt(camera.position); 
                        } else {
                            crossMark.position.y += 0.05;
                            crossMark.rotation.x = -Math.PI / 2;
                            crossMark.rotation.z = camera.rotation.y;
                        }

                        const s = activeObject.userData.crossMarkScale * 0.3;
                        crossMark.scale.set(s, s, s);

                        ui['confirm-button'].disabled = true;
                        ui['confirm-button'].style.opacity = '0.5';
                    }
                } else {
                    crossMark.visible = false;
                }

            } else {
                // ヒットなし
                reticle.visible = false;
                if (isFloorDetected && (currentAppState === APP_STATE.PLACING || currentAppState === APP_STATE.EDITING)) {
                    ui['confirm-button'].disabled = true;
                    const activeObject = getActiveObject();
                    if(activeObject) activeObject.visible = false;
                }
            }
        }
    }

    renderer.render(scene, camera);
}

function handleReticleHover() {
    if (!isEditMode || currentAppState !== APP_STATE.IDLE) {
        if (hoveredObject) {
            setObjectTransparency(hoveredObject, false);
            hoveredObject = null;
            updateUI();
        }
        return;
    }

    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    const intersects = raycaster.intersectObjects(placedObjects, true);

    if (intersects.length > 0) {
        let target = intersects[0].object;
        while(target.parent && !placedObjects.includes(target)) {
            target = target.parent;
        }

        if (placedObjects.includes(target)) {
            if (hoveredObject !== target) {
                if (hoveredObject) setObjectTransparency(hoveredObject, false);
                hoveredObject = target;
                setObjectTransparency(hoveredObject, true, 0.8); 
                updateUI();
            }
            return;
        }
    }

    if (hoveredObject) {
        setObjectTransparency(hoveredObject, false);
        hoveredObject = null;
        updateUI();
    }
}

function checkCollision(activeObj) {
    const activeBox = new THREE.Box3().setFromObject(activeObj);
    activeBox.expandByScalar(-0.05); 

    for (const obj of placedObjects) {
        if (obj === activeObj) continue;
        const otherBox = new THREE.Box3().setFromObject(obj);
        if (activeBox.intersectsBox(otherBox)) return true;
    }
    return false;
}

// ==========================================
// UI更新
// ==========================================

function updateUI() {
    const s = ui;
    
    s['exit-ar-button'].style.display = 'flex';
    s['help-button'].style.display = 'flex';
    s['mode-switch-button'].style.display = 'flex';
    
    if (isEditMode) {
        s['edit-mode-label'].classList.add('active');
        s['view-mode-label'].classList.remove('active');
    } else {
        s['edit-mode-label'].classList.remove('active');
        s['view-mode-label'].classList.add('active');
    }
    
    const isBusy = currentAppState === APP_STATE.PLACING || currentAppState === APP_STATE.EDITING;
    s['mode-switch-button'].style.opacity = isBusy ? '0.5' : '1';
    s['mode-switch-button'].style.pointerEvents = isBusy ? 'none' : 'auto';

    s['add-button'].style.display = 'none';
    s['edit-button'].style.display = 'none';
    s['transform-controls'].style.display = 'none';
    s['decision-controls'].style.display = 'none';

    if (isEditMode) {
        if (currentAppState === APP_STATE.IDLE) {
            if (isFloorDetected) s['add-button'].style.display = 'flex';
            if (hoveredObject) s['edit-button'].style.display = 'flex';
        } else {
            s['transform-controls'].style.display = 'flex';
            s['decision-controls'].style.display = 'flex';
        }
    }
}

function startDotAnimation() {
    if (dotAnimationTimer) return;
    const el = ui['loading-dots'];
    let count = 0;
    dotAnimationTimer = setInterval(() => {
        el.textContent = '.'.repeat((count % 3) + 1);
        count++;
    }, 400);
}

function stopDotAnimation() {
    clearInterval(dotAnimationTimer);
    dotAnimationTimer = null;

}
