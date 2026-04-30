const express = require('express');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const STATEFUL = (process.env.STATEFUL || 'true').toLowerCase() !== 'false';

const DEFAULT_LIST = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'rezervasyonlar.default.json'), 'utf8'),
);

const app = express();
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// state[`${TCKN}_${KART_ID}`] = MENU[]
const state = new Map();

const stateKey = (tckn, kartId) => `${tckn || ''}_${kartId || ''}`;

const cloneList = () => JSON.parse(JSON.stringify(DEFAULT_LIST.RETURN_TABLE));

const getList = (tckn, kartId) => {
  if (!STATEFUL) return cloneList();
  const k = stateKey(tckn, kartId);
  if (!state.has(k)) state.set(k, cloneList());
  return state.get(k);
};

const fail = (description) => ({ RETURN_CODE: 0, RETURN_DESCRIPTION: description });
const ok = (description = 'İşlem başarılı') => ({
  RETURN_CODE: 1,
  RETURN_DESCRIPTION: description,
});

const randomOnayKodu = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase() +
  Math.floor(Math.random() * 9000 + 1000);

// --- form-data + JSON unification: req.body already merged by express middlewares
const readBody = (req) => req.body || {};

// POST /api/EtisanSistem/REZERVASYONLAR
//   body: { TCKN, KART_ID }
//   resp: RET_REZERVASYON_LISTESI
app.post('/api/EtisanSistem/REZERVASYONLAR', (req, res) => {
  const body = readBody(req);
  const tckn = body.TCKN;
  const kartId = body.KART_ID;

  if (!tckn || kartId === undefined || kartId === null || kartId === '') {
    return res.json(fail('İşlem Başarısız.'));
  }

  const list = getList(tckn, kartId);
  return res.json({
    RETURN_CODE: 1,
    RETURN_DESCRIPTION: 'Rezervasyon Listesi Başarılı',
    RETURN_TABLE: list,
  });
});

// POST /api/EtisanSistem/REZERVASYON_EKLE
//   body: { TCKN, YEMEKHANE_ID, KART_ID, EKLEME_CONFIG: { PERIYOT, AMOUNT, SEMA_ID, LOKASYON, KART_MIFARE_NO, GELEN_GUN } }
//   resp: RET_REZERVASYON
app.post('/api/EtisanSistem/REZERVASYON_EKLE', (req, res) => {
  const body = readBody(req);
  const { TCKN, KART_ID, EKLEME_CONFIG } = body;

  if (!TCKN || !KART_ID || !EKLEME_CONFIG) {
    return res.json(fail('İşlem Başarısız.'));
  }

  const semaId = (EKLEME_CONFIG.SEMA_ID || '').toString();
  const periyot = EKLEME_CONFIG.PERIYOT || '';
  const gelenGun = EKLEME_CONFIG.GELEN_GUN
    ? new Date(EKLEME_CONFIG.GELEN_GUN).toISOString().slice(0, 10)
    : '';

  if (STATEFUL) {
    const list = getList(TCKN, KART_ID);
    const matchIndex = list.findIndex((m) => {
      if (!m.EKLEME_CONFIG) return false;
      const sameSema = (m.EKLEME_CONFIG.SEMA_ID || '').toString() === semaId;
      const samePeriyot = (m.EKLEME_CONFIG.PERIYOT || '') === periyot;
      const samegun =
        m.EKLEME_CONFIG.GELEN_GUN &&
        new Date(m.EKLEME_CONFIG.GELEN_GUN).toISOString().slice(0, 10) === gelenGun;
      return sameSema && samePeriyot && samegun && m.REZERVASYONU_VARMI === 0;
    });

    if (matchIndex === -1) {
      return res.json(fail('Bu menü için rezervasyon eklenemedi.'));
    }

    const item = list[matchIndex];
    const onayKodu = randomOnayKodu();
    item.REZERVASYONU_VARMI = 1;
    item.IPTAL_CONFIG = {
      PERIYOT: periyot,
      ONAY_KODU: onayKodu,
      KART_MIFARE_NO: EKLEME_CONFIG.KART_MIFARE_NO || '',
      LOKASYON: EKLEME_CONFIG.LOKASYON || '',
    };
    item.EKLEME_CONFIG = { LOKASYON: item.IPTAL_CONFIG.LOKASYON };
    item.REZERVASYON_UYARI_METIN_BASLIK = null;
    item.REZERVASYON_UYARI_METIN_SUB = null;
  }

  return res.json(ok('Rezervasyon Onaylandı'));
});

// POST /api/EtisanSistem/REZERVASYON_IPTAL
//   body: { TCKN, KART_ID, IPTAL_CONFIG: { PERIYOT, ONAY_KODU, KART_MIFARE_NO, LOKASYON }, YEMEKHANE, TARIH, OGUN }
//   resp: RET_REZERVASYON
app.post('/api/EtisanSistem/REZERVASYON_IPTAL', (req, res) => {
  const body = readBody(req);
  const { TCKN, KART_ID, IPTAL_CONFIG } = body;

  if (!TCKN || !KART_ID || !IPTAL_CONFIG) {
    return res.json(fail('İşlem Başarısız.'));
  }

  const onayKodu = (IPTAL_CONFIG.ONAY_KODU || '').toString();

  if (STATEFUL) {
    const list = getList(TCKN, KART_ID);
    const matchIndex = list.findIndex(
      (m) =>
        m.REZERVASYONU_VARMI === 1 &&
        m.IPTAL_CONFIG &&
        (m.IPTAL_CONFIG.ONAY_KODU || '').toString() === onayKodu,
    );

    if (matchIndex === -1) {
      return res.json(fail('İptal edilecek rezervasyon bulunamadı.'));
    }

    const item = list[matchIndex];
    const periyot = item.IPTAL_CONFIG.PERIYOT || '';
    const lokasyon = item.IPTAL_CONFIG.LOKASYON || '';

    item.REZERVASYONU_VARMI = 0;
    item.IPTAL_CONFIG = null;
    // Restore EKLEME_CONFIG with derivable fields. AMOUNT/SEMA_ID re-derived from default fixture if available.
    const original = DEFAULT_LIST.RETURN_TABLE.find(
      (orig) =>
        orig.EKLEME_CONFIG &&
        (orig.EKLEME_CONFIG.PERIYOT || '') === periyot &&
        orig.MENU_ADI === item.MENU_ADI,
    );
    if (original && original.EKLEME_CONFIG) {
      item.EKLEME_CONFIG = JSON.parse(JSON.stringify(original.EKLEME_CONFIG));
      item.EKLEME_CONFIG.LOKASYON = lokasyon;
    } else {
      item.EKLEME_CONFIG = {
        PERIYOT: periyot,
        AMOUNT: 0,
        SEMA_ID: '',
        LOKASYON: lokasyon,
        KART_MIFARE_NO: '',
        GELEN_GUN: null,
      };
    }
  }

  return res.json(ok('Rezervasyon İptal Edildi'));
});

// --- Admin endpoints (mock-only, not in real service) -----------------------
app.post('/__mock/reset', (req, res) => {
  state.clear();
  res.json({ ok: true, cleared: true });
});

app.get('/__mock/state', (req, res) => {
  const out = {};
  for (const [k, v] of state.entries()) out[k] = v;
  res.json(out);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// 404 fallback that returns the standard error envelope so callers don't break
app.use((req, res) => {
  res.status(404).json(fail(`Endpoint bulunamadı: ${req.method} ${req.path}`));
});

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[etisan-mock] listening on http://${HOST}:${PORT} (stateful=${STATEFUL})`,
  );
});
