const STORAGE_KEY = 'conditions-design-massing-v2';
const MAX_BLOCKS = 100;
const DIMENSION_MIN = 2;
const DIMENSION_MAX = 300;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function validBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const [x, z, width, depth, height, baseOffsetM] = ['x', 'z', 'width', 'depth', 'height', 'baseOffsetM'].map(key => Number(raw[key] ?? (key === 'baseOffsetM' ? 0 : NaN)));
  if (![x, z, width, depth, height, baseOffsetM].every(Number.isFinite) || Math.abs(x) > 5000 || Math.abs(z) > 5000
    || [width, depth, height].some(value => value < DIMENSION_MIN || value > DIMENSION_MAX) || baseOffsetM < 0 || baseOffsetM > 900) return null;
  const id = typeof raw.id === 'string' && /^[\w-]{1,80}$/.test(raw.id) ? raw.id : null;
  const rotationDeg = Number.isFinite(Number(raw.rotationDeg)) ? ((Number(raw.rotationDeg) % 360) + 360) % 360 : 0;
  const baseRing = Array.isArray(raw.baseRing) && raw.baseRing.length >= 3
    && raw.baseRing.length <= 256 && raw.baseRing.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))
    ? raw.baseRing.map(([px, pz]) => [Number(px), Number(pz)]) : null;
  const baseHoles = Array.isArray(raw.baseHoles) ? raw.baseHoles.filter(ring => Array.isArray(ring) && ring.length >= 3
    && ring.length <= 256 && ring.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)))
    .map(ring => ring.map(([px, pz]) => [Number(px), Number(pz)])) : [];
  const groundM = raw.groundM !== null && raw.groundM !== undefined && Number.isFinite(Number(raw.groundM)) ? Number(raw.groundM) : null;
  const baseWidth = Number(raw.baseWidth), baseDepth = Number(raw.baseDepth);
  return id ? { id, x, z, width, depth, height, baseOffsetM,
    supportId: typeof raw.supportId === 'string' ? raw.supportId : null,
    baseRing, baseHoles, groundM, rotationDeg,
    baseWidth: baseRing && baseWidth > 0 ? baseWidth : width,
    baseDepth: baseRing && baseDepth > 0 ? baseDepth : depth,
    modifiedBuildingIndex: Number.isInteger(raw.modifiedBuildingIndex) ? raw.modifiedBuildingIndex : null } : null;
}

function readSaved() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem('conditions-design-massing-v1') || '{}');
    if (Array.isArray(parsed)) return { blocks: parsed.map(validBlock).filter(Boolean).slice(-MAX_BLOCKS), removed: [], proposalId: null };
    return { blocks: Array.isArray(parsed.blocks) ? parsed.blocks.map(validBlock).filter(Boolean).slice(-MAX_BLOCKS) : [],
      removed: Array.isArray(parsed.removed) ? parsed.removed.filter(Number.isInteger) : [],
      proposalId: typeof parsed.proposal_id === 'string' && /^[\w-]{1,80}$/.test(parsed.proposal_id) ? parsed.proposal_id : null };
  } catch { return { blocks: [], removed: [], proposalId: null }; }
}

export function createDesignMassing({ THREE, scene, camera, terrainMesh, terrainSurfaceHeightAt, terrainValidAt, requestRender, focusPlacedBlock = () => {}, addScenePickHandler, canvas, buildingRecords = [], onChange = () => {} }) {
  const root = new THREE.Group(); root.name = 'concept-design-massing'; scene.add(root);
  const buildingOutline = new THREE.Group(); buildingOutline.name = 'design-selected-building'; scene.add(buildingOutline);
  const saved = readSaved();
  const blocks = [], byId = new Map(), removed = new Set(saved.removed.filter(index => index >= 0 && index < buildingRecords.length));
  const mappedBuildingFootprints = buildingRecords.map((record, index) => {
    const outer = record?.[2];
    if (!Array.isArray(outer) || outer.length < 3) return null;
    return {
      index, outer, holes: Array.isArray(record[13]) ? record[13] : [],
      bounds: [Math.min(...outer.map(point => point[0])), Math.min(...outer.map(point => point[1])),
        Math.max(...outer.map(point => point[0])), Math.max(...outer.map(point => point[1]))],
    };
  });
  let proposalId = saved.proposalId || globalThis.crypto?.randomUUID?.() || `proposal-${Date.now()}`;
  let selectedId = null, selectedBuilding = null, mode = null, seq = 0, handleDrag = null;
  const el = id => document.getElementById(id);
  const width = el('massing-width'), depth = el('massing-depth'), height = el('massing-height');
  const rotation = el('massing-rotation');
  const status = el('massing-status'), blockList = el('massing-list'), buildingList = el('massing-building-list');
  const selectBuildingButton = el('massing-select-building'), placeButton = el('massing-place'), moveButton = el('massing-move');
  const setStatus = text => { if (status) status.textContent = text; };
  const selected = () => byId.get(selectedId) || null;
  const dimensions = () => {
    const values = [width, depth, height].map(input => Number(input?.value));
    if (!values.every(value => Number.isFinite(value) && value >= DIMENSION_MIN && value <= DIMENSION_MAX)) {
      setStatus('Enter width, depth, and height between 2 and 300 metres.'); return null;
    }
    return { width: values[0], depth: values[1], height: values[2] };
  };
  const transformRing = (block, points, scaled = false) => {
    const angle = (Number(block.rotationDeg) || 0) * Math.PI / 180;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    return points.map(([x, z]) => {
      const sx = scaled ? x * block.width / block.baseWidth : x;
      const sz = scaled ? z * block.depth / block.baseDepth : z;
      return [block.x + sx * cosine + sz * sine, block.z - sx * sine + sz * cosine];
    });
  };
  const worldRing = block => transformRing(block, block.baseRing || [
    [-block.width / 2, -block.depth / 2], [block.width / 2, -block.depth / 2],
    [block.width / 2, block.depth / 2], [-block.width / 2, block.depth / 2],
  ], Boolean(block.baseRing));
  const worldHoles = block => (block.baseHoles || []).map(ring => transformRing(block, ring, true));
  const pointInRing = (x, z, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i], [xj, zj] = ring[j];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-12) + xi) inside = !inside;
    }
    return inside;
  };
  const showBuildingOutline = index => {
    for (const child of buildingOutline.children) { child.geometry?.dispose(); child.material?.dispose(); }
    buildingOutline.clear();
    const record = index === null ? null : buildingRecords[index], ring = record?.[2];
    if (!ring?.length) return;
    const points = ring.map(([x, z]) => new THREE.Vector3(x, Number(record[0]) + Number(record[1]) + 1.2, z));
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    buildingOutline.add(new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color: 0x39e2a0, transparent: true, opacity: .95, depthTest: false })));
  };
  const footprintMapped = (x, z, w, d, rotationDeg = 0) => {
    const angle = rotationDeg * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
    const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
      .map(([lx, lz]) => [x + lx * cosine + lz * sine, z - lx * sine + lz * cosine]);
    for (let c = 0; c <= Math.ceil(w / 10); c++) for (let r = 0; r <= Math.ceil(d / 10); r++) {
      const lx = -w / 2 + w * c / Math.ceil(w / 10), lz = -d / 2 + d * r / Math.ceil(d / 10);
      if (!terrainValidAt(x + lx * cosine + lz * sine, z - lx * sine + lz * cosine)) return false;
    }
    const blockBounds = [Math.min(...corners.map(point => point[0])), Math.min(...corners.map(point => point[1])),
      Math.max(...corners.map(point => point[0])), Math.max(...corners.map(point => point[1]))];
    const inBlock = (px, pz) => {
      const dx = px - x, dz = pz - z;
      const localX = dx * cosine - dz * sine, localZ = dx * sine + dz * cosine;
      return Math.abs(localX) <= w / 2 && Math.abs(localZ) <= d / 2;
    };
    const intersects = (a, b, c, d) => {
      const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const onSegment = (p, q, r) => q[0] >= Math.min(p[0], r[0]) - 1e-8 && q[0] <= Math.max(p[0], r[0]) + 1e-8
        && q[1] >= Math.min(p[1], r[1]) - 1e-8 && q[1] <= Math.max(p[1], r[1]) + 1e-8;
      const abC = orient(a, b, c), abD = orient(a, b, d), cdA = orient(c, d, a), cdB = orient(c, d, b);
      if ((abC > 0 && abD < 0 || abC < 0 && abD > 0) && (cdA > 0 && cdB < 0 || cdA < 0 && cdB > 0)) return true;
      return Math.abs(abC) < 1e-8 && onSegment(a, c, b) || Math.abs(abD) < 1e-8 && onSegment(a, d, b)
        || Math.abs(cdA) < 1e-8 && onSegment(c, a, d) || Math.abs(cdB) < 1e-8 && onSegment(c, b, d);
    };
    for (const building of mappedBuildingFootprints) {
      if (!building || removed.has(building.index)) continue;
      const { outer, bounds, holes } = building;
      if (bounds[2] < blockBounds[0] || bounds[0] > blockBounds[2] || bounds[3] < blockBounds[1] || bounds[1] > blockBounds[3]) continue;
      const occupied = (pointX, pointZ) => pointInRing(pointX, pointZ, outer)
        && !holes.some(hole => pointInRing(pointX, pointZ, hole));
      if (corners.some(([px, pz]) => occupied(px, pz)) || occupied(x, z) || outer.some(([px, pz]) => inBlock(px, pz))) {
        setStatus('Mapped building occupies this footprint. Select it to modify, replace, or demolish it first.');
        return false;
      }
      for (let a = 0; a < corners.length; a += 1) {
        const nextA = (a + 1) % corners.length;
        for (let b = 0; b < outer.length; b += 1) {
          const nextB = (b + 1) % outer.length;
          if (intersects(corners[a], corners[nextA], outer[b], outer[nextB])) {
            setStatus('Mapped building overlaps this footprint. Select it to modify, replace, or demolish it first.');
            return false;
          }
        }
      }
    }
    return true;
  };
  const persist = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ proposal_id: proposalId, blocks: blocks.map(({ id, x, z, width: w, depth: d, height: h, baseOffsetM, supportId, baseRing, baseHoles, groundM, baseWidth, baseDepth, rotationDeg, modifiedBuildingIndex }) => ({ id, x, z, width: w, depth: d, height: h, baseOffsetM, supportId, baseRing, baseHoles, groundM, baseWidth, baseDepth, rotationDeg, modifiedBuildingIndex })), removed: [...removed] })); return true; }
    catch { return false; }
  };
  const notifyChange = (reviseProposal = true) => {
    if (reviseProposal) proposalId = globalThis.crypto?.randomUUID?.() || `proposal-${Date.now()}-${++seq}`;
    persist();
    const snapshot = blocks.map(block => ({ id: block.id, x: block.x, z: block.z,
      width: block.width, depth: block.depth, height: block.height, rotationDeg: block.rotationDeg || 0,
      baseOffsetM: block.baseOffsetM, supportId: block.supportId, holes: worldHoles(block),
      groundM: block.groundM, ring: worldRing(block), modifiedBuildingIndex: block.modifiedBuildingIndex }));
    onChange([...removed], snapshot, proposalId);
    dispatchEvent(new CustomEvent('climate-design-geometry-change', { detail: {
      proposal_id: proposalId,
      remove_building_indexes: [...removed],
      remove_buildings: [...removed].map(index => {
        const record = buildingRecords[index];
        return record ? { ground_m: Number(record[0]) || 0, height_m: Number(record[1]) || 0,
          ring: record[2] || [], holes: record[3] || [] } : null;
      }).filter(Boolean),
      add_buildings: blocks.map(block => ({
        ground_m: block.groundM ?? terrainSurfaceHeightAt(block.x, block.z) + block.baseOffsetM,
        base_offset_m: Math.max(0, (block.groundM ?? terrainSurfaceHeightAt(block.x, block.z) + block.baseOffsetM) - terrainSurfaceHeightAt(block.x, block.z)),
        height_m: block.height,
        ring: worldRing(block),
        holes: worldHoles(block),
      })),
    } }));
    requestRender();
  };
  const makeVisual = block => {
    let geometry;
    if (block.baseRing) {
      const shape = new THREE.Shape();
      block.baseRing.forEach(([x, z], index) => {
        const px = x * block.width / block.baseWidth;
        const pz = -z * block.depth / block.baseDepth;
        if (index === 0) shape.moveTo(px, pz); else shape.lineTo(px, pz);
      });
      for (const hole of block.baseHoles || []) {
        const path = new THREE.Path();
        hole.forEach(([x, z], index) => {
          const px = x * block.width / block.baseWidth;
          const pz = -z * block.depth / block.baseDepth;
          if (index === 0) path.moveTo(px, pz); else path.lineTo(px, pz);
        });
        path.closePath();
        shape.holes.push(path);
      }
      shape.closePath();
      geometry = new THREE.ExtrudeGeometry(shape, { depth: block.height, bevelEnabled: false, curveSegments: 1 });
      geometry.rotateX(-Math.PI / 2);
    } else {
      geometry = new THREE.BoxGeometry(block.width, block.height, block.depth);
    }
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xcbd9d3, roughness: .86, emissive: 0x071512, flatShading: true }));
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.designBlockId = block.id;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: 0x6b9685, transparent: true, opacity: .85 }));
    const group = new THREE.Group();
    const baseY = block.groundM ?? terrainSurfaceHeightAt(block.x, block.z) + block.baseOffsetM;
    group.position.set(block.x, baseY + (block.baseRing ? 0 : block.height / 2), block.z); group.add(mesh, edges); root.add(group);
    group.rotation.y = (Number(block.rotationDeg) || 0) * Math.PI / 180;
    return { group, mesh, edges };
  };
  const style = block => {
    const active = block.id === selectedId;
    block.mesh.material.color.setHex(active ? 0x8df2ca : 0xb9d8cc);
    block.mesh.material.emissive.setHex(active ? 0x24674d : 0x123b2e);
    block.edges.material.color.setHex(active ? 0x43ffc0 : 0x57cda0);
  };
  const handleGroup = new THREE.Group();
  handleGroup.name = 'design-block-edit-handles';
  handleGroup.renderOrder = 50;
  scene.add(handleGroup);
  const handleTypes = [
    ['width', 0x37e3a4], ['length', 0x48bfff], ['height', 0xffd05c], ['rotate', 0xd68bff],
  ];
  const handleGeometry = new THREE.SphereGeometry(4.2, 16, 12);
  const handleMeshes = new Map();
  for (const [type, color] of handleTypes) {
    const mesh = new THREE.Mesh(handleGeometry, new THREE.MeshBasicMaterial({
      color, depthTest: false, depthWrite: false, toneMapped: false,
    }));
    mesh.name = `design-handle-${type}`;
    mesh.renderOrder = 50;
    handleGroup.add(mesh);
    handleMeshes.set(type, mesh);
  }
  const handleWorldPosition = (block, type) => {
    const baseY = block.groundM ?? terrainSurfaceHeightAt(block.x, block.z) + block.baseOffsetM;
    const angle = (Number(block.rotationDeg) || 0) * Math.PI / 180;
    let localX = 0, localZ = 0, y = baseY + block.height / 2;
    if (type === 'width') localX = block.width / 2 + 5;
    if (type === 'length') localZ = block.depth / 2 + 5;
    if (type === 'height') y = baseY + block.height + 5;
    if (type === 'rotate') { localX = block.width / 2 + 8; localZ = block.depth / 2 + 8; }
    return new THREE.Vector3(
      block.x + localX * Math.cos(angle) + localZ * Math.sin(angle),
      y,
      block.z - localX * Math.sin(angle) + localZ * Math.cos(angle),
    );
  };
  const updateHandles = () => {
    const block = selected();
    handleGroup.visible = Boolean(block && selectedBuilding === null && !mode);
    if (!block) return;
    for (const [type, mesh] of handleMeshes) mesh.position.copy(handleWorldPosition(block, type));
  };
  const rebuildLists = () => {
    if (blockList) {
      blockList.replaceChildren();
      blocks.forEach((block, index) => {
        const li = document.createElement('li'), button = document.createElement('button');
        button.type = 'button'; button.className = 'massing-item'; button.setAttribute('aria-pressed', String(block.id === selectedId));
        button.textContent = `${Number.isInteger(block.modifiedBuildingIndex) ? `Modified building ${block.modifiedBuildingIndex + 1}` : `Block ${index + 1}`} · ${block.width} × ${block.depth} × ${block.height} m · ${Math.round(block.rotationDeg || 0)}°${block.supportId ? ' · stacked' : ''}`;
        button.addEventListener('click', () => selectBlock(block.id)); li.append(button); blockList.append(li);
      });
    }
    if (buildingList) {
      buildingList.replaceChildren();
      [...removed].sort((a, b) => a - b).forEach(index => {
        const li = document.createElement('li'), button = document.createElement('button');
        button.type = 'button'; button.className = 'massing-item'; button.textContent = `Building ${index + 1} · restore`;
        button.addEventListener('click', () => restore(index)); li.append(button); buildingList.append(li);
      });
    }
    if (el('massing-count')) el('massing-count').textContent = String(blocks.length);
    if (el('massing-removed-count')) el('massing-removed-count').textContent = String(removed.size);
    if (el('massing-building-list-wrap')) el('massing-building-list-wrap').hidden = !removed.size;
    const hasBlock = Boolean(selected());
    for (const id of ['massing-update', 'massing-move', 'massing-delete', 'massing-stack']) if (el(id)) el(id).disabled = !hasBlock;
    if (el('massing-clear')) el('massing-clear').disabled = !blocks.length;
    if (el('massing-restore')) el('massing-restore').disabled = !removed.size;
    if (el('massing-demolish')) el('massing-demolish').disabled = selectedBuilding === null;
    if (el('massing-replace')) el('massing-replace').disabled = selectedBuilding === null;
    if (el('massing-modify')) el('massing-modify').disabled = selectedBuilding === null;
    if (el('design-export')) el('design-export').disabled = !blocks.length && !removed.size;
    updateHandles();
    dispatchEvent(new CustomEvent('climate-design-change'));
  };
  function selectBlock(id) {
    selectedId = byId.has(id) ? id : null; selectedBuilding = null; showBuildingOutline(null);
    blocks.forEach(style); const block = selected();
    if (block) { width.value = block.width; depth.value = block.depth; height.value = block.height; if (rotation) rotation.value = String(Math.round(block.rotationDeg || 0)); setStatus('Drag the green width, blue length, yellow height, or purple rotate handle on the map. Touch works too.'); }
    updateHandles();
    rebuildLists(); requestRender();
  }
  const addBlock = (x, z, size, baseOffsetM = 0, supportId = null, force = false, shape = {}) => {
    if (blocks.length >= MAX_BLOCKS) { setStatus(`Maximum ${MAX_BLOCKS} blocks reached.`); return null; }
    if (!force && !footprintMapped(x, z, size.width, size.depth, size.rotationDeg || 0)) { setStatus('Place the whole block on clear mapped ground.'); return null; }
    const id = globalThis.crypto?.randomUUID?.() || `block-${Date.now()}-${++seq}`;
    const block = { id, x, z, ...size, baseOffsetM, supportId, ...shape,
      ...makeVisual({ id, x, z, ...size, baseOffsetM, ...shape }) };
    blocks.push(block); byId.set(id, block); selectBlock(id); persist(); notifyChange();
    if (mode === 'place') focusPlacedBlock(x, z, size.height);
    setStatus(`Block placed at ${Math.round(x)} m east, ${Math.round(z)} m south · drag its coloured handles to edit.`);
    return block;
  };
  const stopMode = message => { mode = null; if (selectBuildingButton) selectBuildingButton.textContent = 'Select existing building'; if (placeButton) placeButton.textContent = 'Place block'; if (moveButton) moveButton.textContent = 'Move selected'; canvas.style.cursor = ''; updateHandles(); if (message) setStatus(message); };
  const startMode = next => {
    if ((next === 'place' || next === 'move') && !dimensions() && next === 'place') return;
    document.querySelector('#place-inspector-pick[aria-pressed="true"]')?.click();
    document.querySelector('#streetview-drop[aria-pressed="true"]')?.click();
    dispatchEvent(new CustomEvent('climate-route-pick-request', { detail: { role: null } }));
    dispatchEvent(new CustomEvent('climate-local-note-pick-mode', { detail: { enabled: false } }));
    mode = next; canvas.style.cursor = 'crosshair';
    updateHandles();
    if (next === 'place') placeButton.textContent = 'Cancel placement';
    if (next === 'move') moveButton.textContent = 'Cancel move';
    if (next === 'building') selectBuildingButton.textContent = 'Cancel selection';
    setStatus(next === 'building' ? 'Click an existing mapped building to select it.'
      : `Click clear mapped ground. The full ${width.value} × ${depth.value} m footprint must fit. Press Escape to cancel.`);
  };
  const dispose = block => { root.remove(block.group); block.mesh.geometry.dispose(); block.mesh.material.dispose(); block.edges.geometry.dispose(); block.edges.material.dispose(); blockByIdDelete(block.id); };
  function blockByIdDelete(id) { byId.delete(id); }
  const removeBlock = block => { blocks.splice(blocks.indexOf(block), 1); dispose(block); for (const child of blocks) if (child.supportId === block.id) { child.supportId = block.supportId; child.baseOffsetM = block.baseOffsetM; } };
  const descendants = id => blocks.filter(b => b.supportId === id);
  const cascadeDelete = id => { descendants(id).forEach(child => cascadeDelete(child.id)); const block = byId.get(id); if (block) removeBlock(block); };
  const rebuildBlock = block => {
    root.remove(block.group); block.mesh.geometry.dispose(); block.mesh.material.dispose(); block.edges.geometry.dispose(); block.edges.material.dispose();
    Object.assign(block, makeVisual(block)); style(block);
    updateHandles();
  };
  const syncDescendants = parent => descendants(parent.id).forEach(child => {
    child.x = parent.x; child.z = parent.z;
    child.baseOffsetM = (parent.groundM ?? terrainSurfaceHeightAt(parent.x, parent.z) + parent.baseOffsetM)
      - terrainSurfaceHeightAt(parent.x, parent.z) + parent.height;
    child.groundM = null;
    rebuildBlock(child); syncDescendants(child);
  });
  const updateSelected = () => { const b = selected(), size = dimensions(); if (!b || !size) return; const rotationDeg = Number(rotation?.value ?? b.rotationDeg ?? 0); if (!Number.isFinite(rotationDeg) || rotationDeg < 0 || rotationDeg > 359) { setStatus('Enter a rotation between 0° and 359°.'); return; } if (!b.supportId && b.modifiedBuildingIndex == null && !footprintMapped(b.x, b.z, size.width, size.depth, rotationDeg)) { setStatus('The whole rotated footprint must fit on clear mapped ground.'); return; } Object.assign(b, size, { rotationDeg }); rebuildBlock(b); syncDescendants(b); notifyChange(); persist(); rebuildLists(); };
  const restore = index => { removed.delete(index); persist(); notifyChange(); rebuildLists(); setStatus(`Building ${index + 1} restored.`); };
  const modifySelectedBuilding = () => {
    if (selectedBuilding === null) return;
    const index = selectedBuilding, record = buildingRecords[index], ring = record?.[2] || [];
    const size = dimensions();
    if (!size || ring.length < 3) return;
    const xs = ring.map(point => Number(point[0])), zs = ring.map(point => Number(point[1]));
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const centerZ = (Math.min(...zs) + Math.max(...zs)) / 2;
    const baseWidth = Math.max(...xs) - Math.min(...xs), baseDepth = Math.max(...zs) - Math.min(...zs);
    const baseRing = ring.map(([x, z]) => [Number(x) - centerX, Number(z) - centerZ]);
    const baseHoles = (Array.isArray(record[13]) ? record[13] : []).map(hole => hole.map(([x, z]) => [Number(x) - centerX, Number(z) - centerZ]));
    const baseOffsetM = Number(record[10]) || 0;
    removed.add(index);
    selectedBuilding = null;
    showBuildingOutline(null);
    const block = addBlock(centerX, centerZ, {
      ...size,
      width: Math.max(DIMENSION_MIN, Math.min(DIMENSION_MAX, size.width)),
      depth: Math.max(DIMENSION_MIN, Math.min(DIMENSION_MAX, size.depth)),
      height: Math.max(DIMENSION_MIN, size.height - baseOffsetM),
    }, 0, null, true, {
      baseRing, baseWidth: Math.max(baseWidth, DIMENSION_MIN), baseDepth: Math.max(baseDepth, DIMENSION_MIN),
      groundM: (Number(record[0]) || 0) + baseOffsetM, modifiedBuildingIndex: index, baseHoles,
    });
    if (block) {
      setStatus(`Building ${index + 1} is editable · its mapped polygon is retained. Scale the footprint or change its height.`);
    } else {
      removed.delete(index);
      rebuildLists();
    }
  };
  el('massing-select-building')?.addEventListener('click', () => mode === 'building' ? stopMode('Selection cancelled.') : startMode('building'));
  el('massing-place')?.addEventListener('click', () => mode === 'place' ? stopMode('Placement cancelled.') : startMode('place'));
  el('massing-move')?.addEventListener('click', () => mode === 'move' ? stopMode('Move cancelled.') : selected() && startMode('move'));
  el('massing-update')?.addEventListener('click', updateSelected);
  let editTimer = 0;
  [width, depth, height, rotation].filter(Boolean).forEach(input => input.addEventListener('input', () => {
    clearTimeout(editTimer);
    editTimer = setTimeout(updateSelected, 180);
  }));
  el('massing-modify')?.addEventListener('click', modifySelectedBuilding);
  el('massing-stack')?.addEventListener('click', () => { const base = selected(), size = dimensions(); if (!base || !size) return; const baseOffsetM = (base.groundM ?? terrainSurfaceHeightAt(base.x, base.z) + base.baseOffsetM) - terrainSurfaceHeightAt(base.x, base.z) + base.height; const b = addBlock(base.x, base.z, size, baseOffsetM, base.id, true); if (b) { persist(); notifyChange(); setStatus('Block stacked above the selected block.'); } });
  el('massing-demolish')?.addEventListener('click', () => { if (selectedBuilding === null) return; dispatchEvent(new CustomEvent('climate-building-demolition-start', { detail: { index: selectedBuilding } })); removed.add(selectedBuilding); selectedBuilding = null; showBuildingOutline(null); persist(); notifyChange(); rebuildLists(); setStatus('Building demolished from the design scenario.'); });
  el('massing-replace')?.addEventListener('click', () => { if (selectedBuilding === null) return; const index = selectedBuilding, record = buildingRecords[index], ring = record?.[2] || []; if (ring.length < 3) return; const xs = ring.map(p => p[0]), zs = ring.map(p => p[1]); const w = Math.max(2, Math.min(300, Math.max(...xs) - Math.min(...xs))), d = Math.max(2, Math.min(300, Math.max(...zs) - Math.min(...zs))); dispatchEvent(new CustomEvent('climate-building-demolition-start', { detail: { index } })); removed.add(index); selectedBuilding = null; showBuildingOutline(null); addBlock((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2, { width: w, depth: d, height: Math.max(2, Math.min(300, Number(record[1]) || 12)) }, 0, null, true); persist(); notifyChange(); rebuildLists(); setStatus('Existing building removed and replaced with a simple rectangular concept block.'); });
  el('massing-delete')?.addEventListener('click', () => { const b = selected(); if (!b) return; cascadeDelete(b.id); selectedId = null; persist(); notifyChange(); rebuildLists(); setStatus('Selected block and supported stack removed.'); });
  el('massing-clear')?.addEventListener('click', () => { [...blocks].forEach(b => cascadeDelete(b.id)); selectedId = null; persist(); notifyChange(); rebuildLists(); setStatus('All proposal blocks cleared.'); });
  el('massing-restore')?.addEventListener('click', () => { removed.clear(); persist(); notifyChange(); rebuildLists(); setStatus('All demolished buildings restored.'); });
  el('design-export')?.addEventListener('click', () => {
    const proposal = { format: 'conditions-design-proposal', version: 2,
      name: (el('design-name')?.value || 'Design proposal').trim().slice(0, 64), proposal_id: proposalId, direction_deg: Number(el('design-wind-direction')?.value) || 135,
      remove_building_indexes: [...removed].sort((a, b) => a - b),
      blocks: blocks.map(b => ({ id: b.id, x: b.x, z: b.z, width: b.width, depth: b.depth, height: b.height, rotation_deg: b.rotationDeg || 0,
        ground_m: b.groundM ?? terrainSurfaceHeightAt(b.x, b.z) + b.baseOffsetM,
        base_offset_m: Math.max(0, (b.groundM ?? terrainSurfaceHeightAt(b.x, b.z) + b.baseOffsetM) - terrainSurfaceHeightAt(b.x, b.z)),
        support_id: b.supportId, modified_building_index: b.modifiedBuildingIndex,
        ring: worldRing(b), holes: worldHoles(b) })),
      // Keep the simple geometry array understood by the offline case builder.
      add_buildings: blocks.map(b => [b.groundM ?? terrainSurfaceHeightAt(b.x, b.z) + b.baseOffsetM, b.height, worldRing(b), worldHoles(b)]) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(proposal, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'conditions-design-proposal.json'; a.click(); URL.revokeObjectURL(url);
    const message = el('design-export-status'); if (message) message.textContent = 'Proposal downloaded.';
  });
  el('design-import')?.addEventListener('click', () => el('design-import-file')?.click());
  el('design-import-file')?.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const proposal = JSON.parse(await file.text());
      if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new Error('File must contain a Conditions proposal object.');
      const removedIndexes = proposal.remove_building_indexes ?? proposal.removed_building_indexes ?? [];
      if (!Array.isArray(removedIndexes) || removedIndexes.length > buildingRecords.length
        || removedIndexes.some(index => !Number.isInteger(index) || index < 0 || index >= buildingRecords.length)
        || new Set(removedIndexes).size !== removedIndexes.length) throw new Error('Proposal contains invalid mapped-building indexes.');
      const sourceBlocks = Array.isArray(proposal.blocks) ? proposal.blocks : proposal.add_buildings;
      if (!Array.isArray(sourceBlocks) || sourceBlocks.length > MAX_BLOCKS) throw new Error(`Proposal must contain no more than ${MAX_BLOCKS} blocks.`);
      const decoded = sourceBlocks.map((raw, index) => {
        const legacy = Array.isArray(raw);
        const ring = legacy ? raw[2] : raw?.ring;
        const holes = legacy ? (raw[3] || []) : (raw?.holes || []);
        if (!Array.isArray(ring) || ring.length < 3 || ring.length > 256
          || ring.some(point => !Array.isArray(point) || point.length !== 2 || point.some(value => !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 5000))) {
          throw new Error(`Block ${index + 1} has an invalid footprint.`);
        }
        if (!Array.isArray(holes) || holes.length > 32 || holes.some(hole => !Array.isArray(hole) || hole.length < 3 || hole.length > 256
          || hole.some(point => !Array.isArray(point) || point.length !== 2 || point.some(value => !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 5000)))) {
          throw new Error(`Block ${index + 1} has invalid footprint holes.`);
        }
        const points = ring.map(([x, z]) => [Number(x), Number(z)]);
        if (new Set(points.map(([x, z]) => `${x.toFixed(5)},${z.toFixed(5)}`)).size < 3) throw new Error(`Block ${index + 1} needs three distinct footprint points.`);
        const xs = points.map(point => point[0]), zs = points.map(point => point[1]);
        const x = legacy ? (Math.min(...xs) + Math.max(...xs)) / 2 : Number(raw.x);
        const z = legacy ? (Math.min(...zs) + Math.max(...zs)) / 2 : Number(raw.z);
        const width = legacy ? Math.max(...xs) - Math.min(...xs) : Number(raw.width);
        const depth = legacy ? Math.max(...zs) - Math.min(...zs) : Number(raw.depth);
        const height = Number(legacy ? raw[1] : raw.height);
        const groundM = Number(legacy ? raw[0] : raw.ground_m);
        const baseOffsetM = legacy ? Math.max(0, groundM - terrainSurfaceHeightAt(x, z)) : Number(raw.base_offset_m ?? 0);
        if (![x, z, width, depth, height, groundM, baseOffsetM].every(Number.isFinite)
          || Math.abs(x) > 5000 || Math.abs(z) > 5000
          || [width, depth, height].some(value => value < DIMENSION_MIN || value > DIMENSION_MAX)
          || baseOffsetM < 0 || baseOffsetM > 900) throw new Error(`Block ${index + 1} has invalid dimensions or elevation.`);
        const baseRing = points.map(([px, pz]) => [px - x, pz - z]);
        const baseHoles = holes.map(hole => hole.map(([px, pz]) => [Number(px) - x, Number(pz) - z]));
        const id = typeof raw.id === 'string' && /^[\w-]{1,80}$/.test(raw.id) ? raw.id : `import-${index + 1}`;
        return { id, x, z, width, depth, height, groundM, baseOffsetM,
          supportId: legacy ? null : raw.support_id ?? null,
          baseRing, baseHoles, baseWidth: width, baseDepth: depth,
          rotationDeg: legacy ? 0 : ((Number(raw.rotation_deg) || 0) % 360 + 360) % 360,
          modifiedBuildingIndex: legacy ? null : Number.isInteger(raw.modified_building_index) ? raw.modified_building_index : null };
      });
      if (new Set(decoded.map(block => block.id)).size !== decoded.length) throw new Error('Block IDs must be unique.');
      const ids = new Set(decoded.map(block => block.id));
      if (decoded.some(block => block.supportId && (!ids.has(block.supportId) || block.supportId === block.id))) throw new Error('A stacked block refers to a missing support block.');

      if (blocks.length || removed.size) {
        if (!globalThis.confirm?.('Replace the current browser proposal with this imported proposal?')) return;
      }
      for (const block of [...blocks]) dispose(block);
      blocks.length = 0; byId.clear(); removed.clear(); removedIndexes.forEach(index => removed.add(index));
      decoded.forEach(block => {
        Object.assign(block, makeVisual(block));
        blocks.push(block); byId.set(block.id, block);
      });
      proposalId = typeof proposal.proposal_id === 'string' && /^[\w-]{1,80}$/.test(proposal.proposal_id)
        ? proposal.proposal_id : globalThis.crypto?.randomUUID?.() || `proposal-${Date.now()}`;
      if (el('design-name') && typeof proposal.name === 'string') el('design-name').value = proposal.name.slice(0, 64);
      selectedId = blocks[0]?.id || null; selectedBuilding = null;
      if (selectedId) selectBlock(selectedId); else { showBuildingOutline(null); rebuildLists(); }
      persist(); notifyChange(false);
      setStatus(`Imported ${blocks.length} proposal block${blocks.length === 1 ? '' : 's'} and ${removed.size} building removal${removed.size === 1 ? '' : 's'}.`);
    } catch (error) {
      setStatus(`Could not import proposal (${error.message}).`);
    }
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && mode) stopMode('Pick mode cancelled.'); });
  addEventListener('climate-menu-change', event => {
    if (['sun', 'viewshed'].includes(event.detail?.name)) return;
    if (mode) stopMode('Pick mode cancelled when leaving Sun or Viewshed.');
    selectedId = null;
    selectedBuilding = null;
    showBuildingOutline(null);
    updateHandles();
    if (blocks.length || removed.size) {
      for (const block of [...blocks]) dispose(block);
      blocks.length = 0;
      byId.clear();
      removed.clear();
      persist();
      notifyChange(false);
      setStatus('Scenario cleared after leaving Sun or Viewshed.');
    }
    rebuildLists();
    requestRender();
  });
  const eventRay = event => {
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    return raycaster.ray;
  };
  const pointerOnPlane = (event, plane) => {
    const point = new THREE.Vector3();
    return eventRay(event).intersectPlane(plane, point) ? point : null;
  };
  const hitHandle = event => {
    if (!handleGroup.visible) return null;
    camera.updateMatrixWorld(true);
    const rect = canvas.getBoundingClientRect();
    const threshold = event.pointerType === 'touch' ? 38 : 22;
    let best = null;
    for (const [type, mesh] of handleMeshes) {
      if (!mesh.visible) continue;
      const projected = mesh.position.clone().project(camera);
      if (projected.z < -1 || projected.z > 1) continue;
      const x = rect.left + (projected.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-projected.y * 0.5 + 0.5) * rect.height;
      const distance = Math.hypot(event.clientX - x, event.clientY - y);
      if (distance <= threshold && (!best || distance < best.distance)) best = { type, distance };
    }
    return best?.type || null;
  };
  const setBlockFields = block => {
    width.value = String(Math.round(block.width * 10) / 10);
    depth.value = String(Math.round(block.depth * 10) / 10);
    height.value = String(Math.round(block.height * 10) / 10);
    if (rotation) rotation.value = String(Math.round(block.rotationDeg || 0) % 360);
  };
  const updateHandleDrag = event => {
    if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
    const point = pointerOnPlane(event, handleDrag.plane);
    if (!point) return;
    const { block, type, start } = handleDrag;
    if (type === 'width' || type === 'length') {
      const dx = point.x - handleDrag.startPoint.x, dz = point.z - handleDrag.startPoint.z;
      const angle = start.rotationDeg * Math.PI / 180;
      const localDelta = type === 'width' ? dx * Math.cos(angle) - dz * Math.sin(angle)
        : dx * Math.sin(angle) + dz * Math.cos(angle);
      const dimension = type === 'width' ? 'width' : 'depth';
      block[dimension] = clamp(start[dimension] + localDelta * 2, DIMENSION_MIN, DIMENSION_MAX);
    } else if (type === 'height') {
      block.height = clamp(start.height + point.y - handleDrag.startPoint.y, DIMENSION_MIN, DIMENSION_MAX);
    } else if (type === 'rotate') {
      const initialAngle = handleDrag.startAngle;
      const currentAngle = Math.atan2(point.z - block.z, point.x - block.x);
      const delta = initialAngle - currentAngle;
      block.rotationDeg = ((start.rotationDeg + delta * 180 / Math.PI) % 360 + 360) % 360;
    }
    const baseY = block.groundM ?? terrainSurfaceHeightAt(block.x, block.z) + block.baseOffsetM;
    block.group.scale.set(block.width / start.width, block.height / start.height, block.depth / start.depth);
    block.group.rotation.y = block.rotationDeg * Math.PI / 180;
    block.group.position.y = baseY + (block.baseRing ? 0 : block.height / 2);
    setBlockFields(block);
    updateHandles();
    requestRender();
  };
  const finishHandleDrag = (event, commit) => {
    if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
    const { block, start } = handleDrag;
    const valid = commit && (block.supportId || block.modifiedBuildingIndex != null
      || footprintMapped(block.x, block.z, block.width, block.depth, block.rotationDeg));
    handleDrag = null;
    if (valid) {
      block.group.scale.set(1, 1, 1);
      rebuildBlock(block);
      syncDescendants(block);
      persist();
      notifyChange();
      rebuildLists();
      setStatus(`Block updated · ${block.width.toFixed(1)} × ${block.depth.toFixed(1)} × ${block.height.toFixed(1)} m · ${Math.round(block.rotationDeg)}°.`);
    } else {
      Object.assign(block, start);
      block.group.scale.set(1, 1, 1);
      rebuildBlock(block);
      setBlockFields(block);
      setStatus(commit
        ? 'That footprint does not fit clear mapped ground. The block was returned to its previous size and angle.'
        : 'Block edit cancelled.');
    }
    requestRender();
  };
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || mode || !selected()) return;
    const type = hitHandle(event);
    if (!type) return;
    const block = selected();
    const start = { width: block.width, depth: block.depth, height: block.height, rotationDeg: block.rotationDeg || 0 };
    const baseY = block.groundM ?? terrainSurfaceHeightAt(block.x, block.z) + block.baseOffsetM;
    let plane;
    if (type === 'height') {
      camera.updateMatrixWorld(true);
      const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
      const normal = new THREE.Vector3(cameraPosition.x - block.x, 0, cameraPosition.z - block.z).normalize();
      plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(block.x, baseY, block.z));
    } else {
      plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -baseY);
    }
    const startPoint = pointerOnPlane(event, plane);
    if (!startPoint) return;
    handleDrag = {
      block, type, start, plane, startPoint, pointerId: event.pointerId,
      startAngle: Math.atan2(startPoint.z - block.z, startPoint.x - block.x),
    };
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Ignore synthetic pointer events. */ }
    event.preventDefault();
    event.stopImmediatePropagation();
    setStatus(type === 'width' ? 'Drag to resize the block width.'
      : type === 'length' ? 'Drag to make the block longer or shorter.'
        : type === 'height' ? 'Drag to raise or lower the block.' : 'Drag around the block to rotate it.');
  }, true);
  canvas.addEventListener('pointermove', event => {
    if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    updateHandleDrag(event);
  }, true);
  canvas.addEventListener('pointerup', event => {
    if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finishHandleDrag(event, true);
  }, true);
  canvas.addEventListener('pointercancel', event => {
    if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finishHandleDrag(event, false);
  }, true);
  addScenePickHandler(({ raycaster }) => {
    if (mode === 'building') {
      const hit = raycaster.intersectObject(terrainMesh, false)[0]; if (!hit) return true;
      const candidates = [];
      buildingRecords.forEach((record, index) => { if (removed.has(index)) return; const ring = record?.[2]; if (ring?.length >= 3 && pointInRing(hit.point.x, hit.point.z, ring)) candidates.push({ index, area: Math.abs(ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0)) }); });
      selectedBuilding = candidates.sort((a, b) => a.area - b.area)[0]?.index ?? null;
      showBuildingOutline(selectedBuilding);
      if (selectedBuilding !== null) {
        const record = buildingRecords[selectedBuilding], ring = record[2];
        const xs = ring.map(point => point[0]), zs = ring.map(point => point[1]);
        width.value = String(Math.max(2, Math.min(300, Math.round(Math.max(...xs) - Math.min(...xs)))));
        depth.value = String(Math.max(2, Math.min(300, Math.round(Math.max(...zs) - Math.min(...zs)))));
        const currentFootprintHeight = Math.max(2, Math.min(300, Math.round((record[1] || 12) - (Number(record[10]) || 0))));
        height.value = String(currentFootprintHeight);
        stopMode(`Building ${selectedBuilding + 1} selected · modify its mapped footprint, demolish it, or replace it.`);
      } else setStatus('No mapped building at that point. Try clicking the centre of a roof.');
      rebuildLists(); requestRender(); return true;
    }
    if (mode === 'place' || mode === 'move') {
      const hit = raycaster.intersectObject(terrainMesh, false)[0]; if (!hit) return true;
      const block = selected(), size = mode === 'place' ? dimensions() : block && { width: block.width, depth: block.depth, height: block.height };
      if (mode === 'place') {
        const placed = size && addBlock(hit.point.x, hit.point.z, { ...size, rotationDeg: Number(rotation?.value) || 0 });
        if (placed) stopMode();
        // Keep placement active after a rejected footprint so the user can
        // choose another site without restarting the tool.
        return true;
      }
      if (size && footprintMapped(hit.point.x, hit.point.z, size.width, size.depth, block.rotationDeg || 0)) {
        block.x = hit.point.x; block.z = hit.point.z; block.baseOffsetM = 0; block.groundM = null; block.supportId = null;
        rebuildBlock(block); syncDescendants(block); persist(); notifyChange();
      } else if (size) setStatus('The whole rotated footprint must fit on mapped terrain.');
      stopMode(); return true;
    }
    const hit = raycaster.intersectObjects(root.children, true).find(candidate => candidate.object.userData.designBlockId);
    if (hit) { selectBlock(hit.object.userData.designBlockId); return true; }
    return false;
  });
  saved.blocks.forEach(block => { if (blocks.length < MAX_BLOCKS) { Object.assign(block, makeVisual(block)); blocks.push(block); byId.set(block.id, block); style(block); seq++; } });
  rebuildLists(); notifyChange(false); return { getBlocks: () => blocks.map(({ id, x, z, width: w, depth: d, height: h, baseOffsetM }) => ({ id, x, z, width: w, depth: d, height: h, baseOffsetM })), getRemoved: () => [...removed] };
}
