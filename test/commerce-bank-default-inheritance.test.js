import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  hasReusablePaymentInfo,
  parseCourseDate,
  latestReusablePaymentCourse
} from '../utils/commerce-bank-defaults.js';

const adminHtml = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const coursesApi = fs.readFileSync(new URL('../api/courses.js', import.meta.url), 'utf8');

// Helper to construct a simulated DOM environment executing openCourseModal from admin.html
function setupAdminModalContext() {
  const elements = {};
  const getOrCreate = (id, initial = {}) => {
    if (!elements[id]) {
      elements[id] = {
        id,
        value: initial.value ?? '',
        checked: initial.checked ?? false,
        innerText: '',
        title: '',
        disabled: false,
        classes: new Set(initial.classes || []),
        classList: {
          add: (...cls) => cls.forEach(c => elements[id].classes.add(c)),
          remove: (...cls) => cls.forEach(c => elements[id].classes.delete(c)),
          toggle: (cls, force) => {
            if (force === undefined) {
              if (elements[id].classes.has(cls)) elements[id].classes.delete(cls);
              else elements[id].classes.add(cls);
            } else if (force) {
              elements[id].classes.add(cls);
            } else {
              elements[id].classes.delete(cls);
            }
          },
          contains: (cls) => elements[id].classes.has(cls)
        }
      };
    }
    return elements[id];
  };

  // Pre-seed known elements
  [
    'courseModal', 'courseForm', 'courseImageUploadStatus', 'qrImageUploadStatus',
    'modalTitle', 'courseId', 'courseTitleInput', 'courseSlugInput', 'coursePriceInput',
    'courseSortOrderInput', 'courseTeacherInput', 'courseExpectedStartDateInput',
    'courseActiveInput', 'courseImageUrlInput', 'courseDescriptionInput',
    'courseDeliveryModeInput', 'telegramChatIdInput', 'telegramChatTitleInput',
    'telegramInviteTtlInput', 'v4TelegramPostLinkInput', 'bankNameInput',
    'bankAccountInput', 'bankOwnerInput', 'transferNoteInput', 'qrImageUrlInput',
    'bankAutoFillHint'
  ].forEach(id => getOrCreate(id));

  // Initialize form mock
  elements.courseForm.reset = function () {
    [
      'bankNameInput', 'bankAccountInput', 'bankOwnerInput', 'transferNoteInput', 'qrImageUrlInput',
      'courseId', 'courseTitleInput', 'courseSlugInput', 'coursePriceInput', 'courseSortOrderInput',
      'courseTeacherInput', 'courseExpectedStartDateInput', 'telegramChatIdInput', 'telegramChatTitleInput',
      'telegramInviteTtlInput', 'v4TelegramPostLinkInput'
    ].forEach(id => {
      elements[id].value = '';
    });
    elements.courseActiveInput.checked = false;
  };

  const context = {
    document: {
      getElementById: (id) => elements[id] || getOrCreate(id)
    },
    allCourses: [],
    courseSlugTouched: false,
    toggleTelegramFields: () => {},
    updateTelegramConnectUi: () => {},
    refreshV5ModalState: () => {},
    elements
  };

  // Extract the function definitions and openCourseModal from admin.html
  const helperCode = adminHtml.slice(
    adminHtml.indexOf('function hasReusablePaymentInfo(course) {'),
    adminHtml.indexOf('function closeCourseModal()')
  );

  vm.createContext(context);
  vm.runInContext(helperCode, context);

  return context;
}

test('Static check: admin.html has the bankAutoFillHint UI element under the bank heading', () => {
  assert.match(adminHtml, /id="bankAutoFillHint"/);
  assert.match(adminHtml, /Đã tự điền theo thông tin chuyển khoản của khóa gần nhất\. Bạn có thể chỉnh sửa cho khóa này\./);
  assert.match(adminHtml, /class="[^"]*text-emerald-700[^"]*bg-emerald-50[^"]*"/);
});

test('Static check: admin.html defines payment helper functions and integrates with openCourseModal', () => {
  assert.match(adminHtml, /function hasReusablePaymentInfo\(course\)/);
  assert.match(adminHtml, /function parseCourseDate\(course\)/);
  assert.match(adminHtml, /function latestReusablePaymentCourse\(courses\)/);
  assert.match(adminHtml, /const sourceCourse = latestReusablePaymentCourse\(allCourses\);/);
});

test('Unit: hasReusablePaymentInfo accurately validates eligibility', () => {
  // Non-objects or null
  assert.equal(hasReusablePaymentInfo(null), false);
  assert.equal(hasReusablePaymentInfo(undefined), false);
  assert.equal(hasReusablePaymentInfo('invalid'), false);
  assert.equal(hasReusablePaymentInfo({}), false);

  // Missing or whitespace-only bankAccount
  assert.equal(hasReusablePaymentInfo({ bankAccount: '', bankName: 'MB Bank' }), false);
  assert.equal(hasReusablePaymentInfo({ bankAccount: '   ', bankName: 'MB Bank' }), false);

  // Has bankAccount but no secondary field (bankName, bankOwner, qrImageUrl)
  assert.equal(hasReusablePaymentInfo({ bankAccount: '0999999999' }), false);
  assert.equal(hasReusablePaymentInfo({ bankAccount: '0999999999', bankName: ' ', bankOwner: '', qrImageUrl: ' ' }), false);

  // Valid combinations
  assert.equal(hasReusablePaymentInfo({ bankAccount: '0999999999', bankName: 'MB Bank' }), true);
  assert.equal(hasReusablePaymentInfo({ bankAccount: '0999999999', bankOwner: 'NGUYEN VAN A' }), true);
  assert.equal(hasReusablePaymentInfo({ bankAccount: '0999999999', qrImageUrl: 'https://img.vietqr.io/qr.png' }), true);
  assert.equal(hasReusablePaymentInfo({
    bankAccount: '0999999999',
    bankName: 'MB Bank',
    bankOwner: 'NGUYEN VAN A',
    transferNote: 'DONUT',
    qrImageUrl: 'https://img.vietqr.io/qr.png'
  }), true);
});

test('Unit: parseCourseDate safely parses dates and handles invalid inputs', () => {
  assert.equal(parseCourseDate(null), 0);
  assert.equal(parseCourseDate({}), 0);
  assert.equal(parseCourseDate({ created_at: null }), 0);
  assert.equal(parseCourseDate({ created_at: 'not-a-date' }), 0);
  assert.equal(parseCourseDate({ created_at: '2026-09-20T10:00:00Z' }), new Date('2026-09-20T10:00:00Z').getTime());
});

test('Case 1: Course A complete bank info -> Create B auto-fills all 5 fields and shows hint', () => {
  const ctx = setupAdminModalContext();
  const courseA = {
    id: 'course-a',
    created_at: '2026-09-20T10:00:00Z',
    bankName: 'MB Bank',
    bankAccount: '0999999999',
    bankOwner: 'NGUYEN VAN A',
    transferNote: 'DONUT A',
    qrImageUrl: 'https://img.vietqr.io/a.png'
  };
  ctx.allCourses = [courseA];

  ctx.openCourseModal(null);

  assert.equal(ctx.elements.bankNameInput.value, 'MB Bank');
  assert.equal(ctx.elements.bankAccountInput.value, '0999999999');
  assert.equal(ctx.elements.bankOwnerInput.value, 'NGUYEN VAN A');
  assert.equal(ctx.elements.transferNoteInput.value, 'DONUT A');
  assert.equal(ctx.elements.qrImageUrlInput.value, 'https://img.vietqr.io/a.png');
  assert.equal(ctx.elements.bankAutoFillHint.classList.contains('hidden'), false, 'Hint should be visible');
});

test('Case 2: User edits B bank info and saves -> Create C auto-fills from B (the newest course)', () => {
  const ctx = setupAdminModalContext();
  const courseA = {
    id: 'course-a',
    created_at: '2026-09-20T10:00:00Z',
    bankName: 'MB Bank',
    bankAccount: '0999999999',
    bankOwner: 'NGUYEN VAN A',
    transferNote: 'DONUT A',
    qrImageUrl: 'https://img.vietqr.io/a.png'
  };
  const courseB = {
    id: 'course-b',
    created_at: '2026-09-21T15:00:00Z',
    bankName: 'Techcombank',
    bankAccount: '1903333333',
    bankOwner: 'NGUYEN VAN B',
    transferNote: 'DONUT B',
    qrImageUrl: 'https://img.vietqr.io/b.png'
  };
  ctx.allCourses = [courseA, courseB];

  ctx.openCourseModal(null);

  assert.equal(ctx.elements.bankNameInput.value, 'Techcombank');
  assert.equal(ctx.elements.bankAccountInput.value, '1903333333');
  assert.equal(ctx.elements.bankOwnerInput.value, 'NGUYEN VAN B');
  assert.equal(ctx.elements.transferNoteInput.value, 'DONUT B');
  assert.equal(ctx.elements.qrImageUrlInput.value, 'https://img.vietqr.io/b.png');
  assert.equal(ctx.elements.bankAutoFillHint.classList.contains('hidden'), false);
});

test('Case 3: Newest course D has empty bank fields -> Create E auto-fills from earlier course C', () => {
  const ctx = setupAdminModalContext();
  const courseC = {
    id: 'course-c',
    created_at: '2026-09-22T08:00:00Z',
    bankName: 'Vietcombank',
    bankAccount: '0011000000',
    bankOwner: 'NGUYEN VAN C',
    transferNote: 'DONUT C',
    qrImageUrl: 'https://img.vietqr.io/c.png'
  };
  const courseD = {
    id: 'course-d',
    created_at: '2026-09-22T14:00:00Z',
    bankName: '',
    bankAccount: '',
    bankOwner: '',
    transferNote: '',
    qrImageUrl: ''
  };
  ctx.allCourses = [courseD, courseC];

  ctx.openCourseModal(null);

  assert.equal(ctx.elements.bankNameInput.value, 'Vietcombank');
  assert.equal(ctx.elements.bankAccountInput.value, '0011000000');
  assert.equal(ctx.elements.bankOwnerInput.value, 'NGUYEN VAN C');
  assert.equal(ctx.elements.transferNoteInput.value, 'DONUT C');
  assert.equal(ctx.elements.qrImageUrlInput.value, 'https://img.vietqr.io/c.png');
  assert.equal(ctx.elements.bankAutoFillHint.classList.contains('hidden'), false);
});

test('Case 4: No course has valid bank info -> form remains empty, hint hidden', () => {
  const ctx = setupAdminModalContext();
  ctx.allCourses = [
    { id: 'c-empty-1', created_at: '2026-09-20T00:00:00Z', bankAccount: '' },
    { id: 'c-empty-2', created_at: '2026-09-21T00:00:00Z', bankAccount: '   ', bankName: 'Some Bank' },
    { id: 'c-empty-3', created_at: '2026-09-22T00:00:00Z', bankAccount: null, bankOwner: 'Some Person' }
  ];

  ctx.openCourseModal(null);

  assert.equal(ctx.elements.bankNameInput.value, '');
  assert.equal(ctx.elements.bankAccountInput.value, '');
  assert.equal(ctx.elements.bankOwnerInput.value, '');
  assert.equal(ctx.elements.transferNoteInput.value, '');
  assert.equal(ctx.elements.qrImageUrlInput.value, '');
  assert.equal(ctx.elements.bankAutoFillHint.classList.contains('hidden'), true, 'Hint should be hidden when no source');
});

test('Case 5: Edit existing course A -> uses A own bank info, never overwritten by newest course', () => {
  const ctx = setupAdminModalContext();
  const courseA = {
    id: 'course-a',
    courseName: 'Khóa A',
    slug: 'khoa-a',
    created_at: '2026-09-20T10:00:00Z',
    bankName: 'ACB',
    bankAccount: '12345678',
    bankOwner: 'CHỦ KHÓA A',
    transferNote: 'NOTE A',
    qrImageUrl: 'https://img.vietqr.io/a.png'
  };
  const courseB = {
    id: 'course-b',
    courseName: 'Khóa B',
    slug: 'khoa-b',
    created_at: '2026-09-22T10:00:00Z',
    bankName: 'VPBank',
    bankAccount: '99999999',
    bankOwner: 'CHỦ KHÓA B',
    transferNote: 'NOTE B',
    qrImageUrl: 'https://img.vietqr.io/b.png'
  };
  ctx.allCourses = [courseB, courseA];

  ctx.openCourseModal(courseA);

  assert.equal(ctx.elements.bankNameInput.value, 'ACB');
  assert.equal(ctx.elements.bankAccountInput.value, '12345678');
  assert.equal(ctx.elements.bankOwnerInput.value, 'CHỦ KHÓA A');
  assert.equal(ctx.elements.transferNoteInput.value, 'NOTE A');
  assert.equal(ctx.elements.qrImageUrlInput.value, 'https://img.vietqr.io/a.png');
  assert.equal(ctx.elements.bankAutoFillHint.classList.contains('hidden'), true, 'Hint must be hidden in Edit mode');
});

test('Case 6: QR URL is inherited with source course', () => {
  const source = latestReusablePaymentCourse([
    {
      id: 'course-qr',
      created_at: '2026-09-21T00:00:00Z',
      bankName: 'MB Bank',
      bankAccount: '0999999999',
      bankOwner: 'NGUYEN VAN A',
      qrImageUrl: 'https://img.vietqr.io/image/MB-0999999999-compact.png?amount=199000&addInfo=DONUT'
    }
  ]);
  assert.equal(source?.qrImageUrl, 'https://img.vietqr.io/image/MB-0999999999-compact.png?amount=199000&addInfo=DONUT');
});

test('Case 7: User edits 1 field -> edited field is retained alongside auto-filled defaults', () => {
  const ctx = setupAdminModalContext();
  ctx.allCourses = [{
    id: 'course-source',
    created_at: '2026-09-21T00:00:00Z',
    bankName: 'MB Bank',
    bankAccount: '0999999999',
    bankOwner: 'NGUYEN VAN A',
    transferNote: 'DEFAULT NOTE',
    qrImageUrl: 'https://img.vietqr.io/source.png'
  }];

  ctx.openCourseModal(null);

  // User modifies transferNote
  ctx.elements.transferNoteInput.value = 'CUSTOM TRANSFER NOTE 123';

  // Verify form state ready for submit
  assert.equal(ctx.elements.bankNameInput.value, 'MB Bank');
  assert.equal(ctx.elements.bankAccountInput.value, '0999999999');
  assert.equal(ctx.elements.bankOwnerInput.value, 'NGUYEN VAN A');
  assert.equal(ctx.elements.transferNoteInput.value, 'CUSTOM TRANSFER NOTE 123');
  assert.equal(ctx.elements.qrImageUrlInput.value, 'https://img.vietqr.io/source.png');
});

test('Case 8: PUT existing course preserves raw_data unrelated fields in api/courses.js', () => {
  // Verifies that base.raw_data = { ...(existing.raw_data || {}), ...base.raw_data } is in api/courses.js
  assert.match(coursesApi, /base\.raw_data\s*=\s*\{\s*\.\.\.\(existing\.raw_data \|\| \{\}\),\s*\.\.\.base\.raw_data\s*\};/);
});

test('Case 9: Quick sale toggle in admin.html preserves bank fields in payload', () => {
  const toggleActiveBlock = adminHtml.slice(
    adminHtml.indexOf('async function toggleCourseActive'),
    adminHtml.indexOf('async function toggleCourseSalePause')
  );
  assert.match(toggleActiveBlock, /bankName:\s*course\.bankName/);
  assert.match(toggleActiveBlock, /bankAccount:\s*course\.bankAccount/);
  assert.match(toggleActiveBlock, /bankOwner:\s*course\.bankOwner/);
  assert.match(toggleActiveBlock, /transferNote:\s*course\.transferNote/);
  assert.match(toggleActiveBlock, /qrImageUrl:\s*course\.qrImageUrl/);
});

test('Case 10: V5 shell newest with no bank info -> falls back to earlier course', () => {
  const ctx = setupAdminModalContext();
  const v4Course = {
    id: 'v4-course-1',
    created_at: '2026-09-22T08:00:00Z',
    deliveryMode: 'v4',
    bankName: 'Techcombank',
    bankAccount: '1902222222',
    bankOwner: 'V4 OWNER',
    transferNote: 'V4 NOTE',
    qrImageUrl: 'https://img.vietqr.io/v4.png'
  };
  const v5Shell = {
    id: 'v5-shell-1',
    created_at: '2026-09-23T08:00:00Z',
    deliveryMode: 'v5',
    bankName: '',
    bankAccount: '',
    bankOwner: '',
    transferNote: '',
    qrImageUrl: ''
  };
  ctx.allCourses = [v5Shell, v4Course];

  ctx.openCourseModal(null);

  assert.equal(ctx.elements.bankNameInput.value, 'Techcombank');
  assert.equal(ctx.elements.bankAccountInput.value, '1902222222');
  assert.equal(ctx.elements.bankOwnerInput.value, 'V4 OWNER');
  assert.equal(ctx.elements.bankAutoFillHint.classList.contains('hidden'), false);
});

test('Case 11: Mode-specific state (V4/Telegram/LMS) is not altered by payment selection', () => {
  const ctx = setupAdminModalContext();
  ctx.allCourses = [{
    id: 'course-src',
    created_at: '2026-09-22T00:00:00Z',
    deliveryMode: 'telegram',
    telegramChatId: '-1009999999',
    telegramChatTitle: 'Channel Title',
    bankName: 'MB Bank',
    bankAccount: '0999999999',
    bankOwner: 'SRC OWNER'
  }];

  ctx.openCourseModal(null);

  // Delivery mode must default to 'lms' in create mode, not copy telegram deliveryMode
  assert.equal(ctx.elements.courseDeliveryModeInput.value, 'lms');
  assert.equal(ctx.elements.telegramChatIdInput.value, '');
  assert.equal(ctx.elements.telegramInviteTtlInput.value, 72);

  // Bank fields are populated
  assert.equal(ctx.elements.bankNameInput.value, 'MB Bank');
  assert.equal(ctx.elements.bankAccountInput.value, '0999999999');
});

test('Case 12: V5 active/is_published/pre-order semantics remain unchanged', () => {
  // New V5 course shell creation in api/courses.js defaults to active = false and is_published = false
  assert.match(coursesApi, /if \(deliveryMode === 'v5'\) \{\s*base\.active = body\.active === true;\s*base\.is_published = false;\s*\}/);
  // Existing V5 courses ignore canonical publish writes
  assert.match(coursesApi, /if \(deliveryMode === 'v5'\) delete base\.is_published;/);
});
