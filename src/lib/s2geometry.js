/**
 * S2 Geometry (Pure ES Module with native BigInt, zero external dependencies)
 * Based on S2 Geometry algorithm adapted for JavaScript
 */

const S2 = { L: {} };

S2.L.LatLng = function (rawLat, rawLng, noWrap) {
  const lat = parseFloat(rawLat);
  const lng = parseFloat(rawLng);

  if (isNaN(lat) || isNaN(lng)) {
    throw new Error('Invalid LatLng object: (' + rawLat + ', ' + rawLng + ')');
  }

  const resLat = noWrap === true ? lat : Math.max(Math.min(lat, 90), -90);
  const resLng = noWrap === true ? lng : ((lng + 180) % 360 + (lng < -180 || lng === 180 ? 180 : -180));

  return { lat: resLat, lng: resLng };
};

S2.L.LatLng.DEG_TO_RAD = Math.PI / 180;
S2.L.LatLng.RAD_TO_DEG = 180 / Math.PI;

function LatLngToXYZ(latLng) {
  const d2r = S2.L.LatLng.DEG_TO_RAD;
  const phi = latLng.lat * d2r;
  const theta = latLng.lng * d2r;
  const cosphi = Math.cos(phi);

  return [Math.cos(theta) * cosphi, Math.sin(theta) * cosphi, Math.sin(phi)];
}

function XYZToFaceUV(xyz) {
  let face = -1;
  let maxVal = -1;
  for (let i = 0; i < 3; i++) {
    const val = Math.abs(xyz[i]);
    if (val > maxVal) {
      maxVal = val;
      face = xyz[i] < 0 ? i + 3 : i;
    }
  }

  let u, v;
  switch (face) {
    case 0: u = xyz[1] / xyz[0]; v = xyz[2] / xyz[0]; break;
    case 1: u = -xyz[0] / xyz[1]; v = xyz[2] / xyz[1]; break;
    case 2: u = -xyz[0] / xyz[2]; v = -xyz[1] / xyz[2]; break;
    case 3: u = xyz[2] / xyz[0]; v = xyz[1] / xyz[0]; break;
    case 4: u = xyz[2] / xyz[1]; v = -xyz[0] / xyz[1]; break;
    case 5: u = -xyz[1] / xyz[2]; v = -xyz[0] / xyz[2]; break;
  }
  return { face: face, uv: [u, v] };
}

function UVToST(uv) {
  function single(val) {
    if (val >= 0) {
      return 0.5 * Math.sqrt(1 + 3 * val);
    } else {
      return 1 - 0.5 * Math.sqrt(1 - 3 * val);
    }
  }
  return [single(uv[0]), single(uv[1])];
}

function STToUV(st) {
  function single(val) {
    if (val >= 0.5) {
      return (1 / 3) * (4 * val * val - 1);
    } else {
      return (1 / 3) * (1 - 4 * (1 - val) * (1 - val));
    }
  }
  return [single(st[0]), single(st[1])];
}

function FaceUVToXYZ(face, uv) {
  const u = uv[0];
  const v = uv[1];
  switch (face) {
    case 0: return [1, u, v];
    case 1: return [-u, 1, v];
    case 2: return [-u, -v, 1];
    case 3: return [-1, -v, -u];
    case 4: return [v, -1, -u];
    case 5: return [v, u, -1];
  }
}

function XYZToLatLng(xyz) {
  const r2d = S2.L.LatLng.RAD_TO_DEG;
  const lat = Math.atan2(xyz[2], Math.sqrt(xyz[0] * xyz[0] + xyz[1] * xyz[1])) * r2d;
  const lng = Math.atan2(xyz[1], xyz[0]) * r2d;
  return { lat: lat, lng: lng };
}

function STToIJ(st, order) {
  const maxSize = 1 << order;
  function single(val) {
    const ij = Math.floor(val * maxSize);
    return Math.max(0, Math.min(maxSize - 1, ij));
  }
  return [single(st[0]), single(st[1])];
}

function IJToST(ij, order, offsets) {
  const maxSize = 1 << order;
  return [(ij[0] + offsets[0]) / maxSize, (ij[1] + offsets[1]) / maxSize];
}

const lookupPos = [
  [0, 1, 3, 2],
  [0, 2, 3, 1],
  [3, 2, 0, 1],
  [3, 1, 0, 2],
];

const lookupIJ = [
  [0, 1, 3, 2],
  [0, 2, 3, 1],
  [3, 2, 0, 1],
  [3, 1, 0, 2],
];

const lookupOrientation = [
  [1, 2, 0, 0],
  [0, 1, 3, 3],
  [2, 0, 1, 1],
  [3, 3, 2, 2],
];

function pointToHilbertQuadList(x, y, order) {
  const hilbertMap = {
    'a': [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }],
    'b': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    'c': [{ x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }],
    'd': [{ x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }],
  };

  let currentSquare = 'a';
  const positions = [];

  for (let i = order - 1; i >= 0; i--) {
    const mask = 1 << i;
    const quadX = (x & mask) ? 1 : 0;
    const quadY = (y & mask) ? 1 : 0;

    let quad = 0;
    const quads = hilbertMap[currentSquare];
    for (let j = 0; j < 4; j++) {
      if (quads[j].x === quadX && quads[j].y === quadY) {
        quad = j;
        break;
      }
    }
    positions.push(quad);

    if (currentSquare === 'a') {
      if (quad === 0) currentSquare = 'b';
      else if (quad === 3) currentSquare = 'd';
    } else if (currentSquare === 'b') {
      if (quad === 0) currentSquare = 'a';
      else if (quad === 3) currentSquare = 'c';
    } else if (currentSquare === 'c') {
      if (quad === 0) currentSquare = 'd';
      else if (quad === 3) currentSquare = 'b';
    } else if (currentSquare === 'd') {
      if (quad === 0) currentSquare = 'c';
      else if (quad === 3) currentSquare = 'a';
    }
  }

  return positions;
}

S2.FACE_BITS = 3;
S2.MAX_LEVEL = 30;
S2.POS_BITS = (2 * S2.MAX_LEVEL) + 1;

S2.facePosLevelToId = S2.fromFacePosLevel = function (faceN, posS, levelN) {
  if (!levelN) levelN = posS.length;
  if (posS.length > levelN) posS = posS.substr(0, levelN);

  const faceVal = parseInt(faceN, 10);
  let faceB = faceVal.toString(2);
  while (faceB.length < S2.FACE_BITS) faceB = '0' + faceB;

  const digitMap = { '0': '00', '1': '01', '2': '10', '3': '11' };
  let posB = posS.split('').map(d => digitMap[d] || '00').join('');
  while (posB.length < (2 * levelN)) posB = '0' + posB;

  let bin = faceB + posB + '1';
  while (bin.length < (S2.FACE_BITS + S2.POS_BITS)) bin += '0';

  return BigInt('0b' + bin).toString(10);
};

S2.keyToId = function (key) {
  const parts = key.split('/');
  return S2.fromFacePosLevel(parts[0], parts[1], parts[1].length);
};

S2.idToKey = function (idS) {
  let bin = BigInt(idS).toString(2);
  while (bin.length < (S2.FACE_BITS + S2.POS_BITS)) bin = '0' + bin;

  const lsbIndex = bin.lastIndexOf('1');
  const faceB = bin.substring(0, 3);
  const posB = bin.substring(3, lsbIndex);
  const levelN = Math.floor(posB.length / 2);

  const faceS = parseInt(faceB, 2).toString(10);
  let posS = '';
  for (let i = 0; i < posB.length; i += 2) {
    posS += parseInt(posB.substr(i, 2), 2).toString();
  }

  while (posS.length < levelN) posS = '0' + posS;
  return faceS + '/' + posS;
};

S2.S2Cell = function () {};

S2.S2Cell.FromFaceIJ = function (face, ij, level) {
  const cell = new S2.S2Cell();
  cell.face = face;
  cell.ij = ij;
  cell.level = level;
  return cell;
};

S2.S2Cell.FromLatLng = function (latLng, level) {
  const xyz = LatLngToXYZ(latLng);
  const faceuv = XYZToFaceUV(xyz);
  const st = UVToST(faceuv.uv);
  const ij = STToIJ(st, level);
  return S2.S2Cell.FromFaceIJ(faceuv.face, ij, level);
};

S2.S2Cell.prototype.toHilbertQuadkey = function () {
  const quads = pointToHilbertQuadList(this.ij[0], this.ij[1], this.level);
  return this.face + '/' + quads.join('');
};

S2.S2Cell.prototype.getCornerLatLngs = function () {
  const result = [];
  const offsets = [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0],
  ];

  for (let i = 0; i < 4; i++) {
    const st = IJToST(this.ij, this.level, offsets[i]);
    const uv = STToUV(st);
    const xyz = FaceUVToXYZ(this.face, uv);
    result.push(XYZToLatLng(xyz));
  }
  return result;
};

S2.S2Cell.prototype.getLatLng = function () {
  const st = IJToST(this.ij, this.level, [0.5, 0.5]);
  const uv = STToUV(st);
  const xyz = FaceUVToXYZ(this.face, uv);
  return XYZToLatLng(xyz);
};

S2.S2Cell.prototype.getNeighbors = function () {
  const fromFaceIJ = S2.S2Cell.FromFaceIJ;
  const face = this.face;
  const i = this.ij[0];
  const j = this.ij[1];
  const level = this.level;
  const maxSize = 1 << level;

  const neighbors = [];
  const deltas = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  for (let d = 0; d < deltas.length; d++) {
    const ni = i + deltas[d][0];
    const nj = j + deltas[d][1];
    if (ni >= 0 && ni < maxSize && nj >= 0 && nj < maxSize) {
      neighbors.push(fromFaceIJ(face, [ni, nj], level));
    }
  }
  return neighbors;
};

S2.S2Cell.FromHilbertQuadKey = function (hilbertQuadkey) {
  const parts = hilbertQuadkey.split('/');
  const face = parseInt(parts[0], 10);
  const position = parts[1];
  const level = position.length;

  let x = 0;
  let y = 0;
  let currentSquare = 'a';

  const hilbertMap = {
    'a': [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }],
    'b': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    'c': [{ x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }],
    'd': [{ x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }],
  };

  for (let i = 0; i < level; i++) {
    const bit = 1 << (level - i - 1);
    const quad = parseInt(position[i], 10);
    const coord = hilbertMap[currentSquare][quad];

    if (coord.x) x |= bit;
    if (coord.y) y |= bit;

    if (currentSquare === 'a') {
      if (quad === 0) currentSquare = 'b';
      else if (quad === 3) currentSquare = 'd';
    } else if (currentSquare === 'b') {
      if (quad === 0) currentSquare = 'a';
      else if (quad === 3) currentSquare = 'c';
    } else if (currentSquare === 'c') {
      if (quad === 0) currentSquare = 'd';
      else if (quad === 3) currentSquare = 'b';
    } else if (currentSquare === 'd') {
      if (quad === 0) currentSquare = 'c';
      else if (quad === 3) currentSquare = 'a';
    }
  }

  return S2.S2Cell.FromFaceIJ(face, [x, y], level);
};

S2.latLngToKey = function (lat, lng, level) {
  return S2.S2Cell.FromLatLng({ lat: lat, lng: lng }, level).toHilbertQuadkey();
};

S2.keyToLatLng = function (key) {
  return S2.S2Cell.FromHilbertQuadKey(key).getLatLng();
};

S2.idToLatLng = function (id) {
  return S2.keyToLatLng(S2.idToKey(id));
};

export { S2 };
export default S2;
