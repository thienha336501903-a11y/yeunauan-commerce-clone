const fs = require('fs');

const path = 'admin.html';
let text = fs.readFileSync(path, 'utf8');

function replaceBetween(startMarker, endMarker, replacement, label) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error('Missing start marker: ' + label);
  const end = text.indexOf(endMarker, start);
  if (end < 0) throw new Error('Missing end marker: ' + label);
  text = text.slice(0, start) + replacement + text.slice(end);
}

const telegramFields = `          <div id="telegramCourseFields" class="hidden mt-4 space-y-4">
            <input type="hidden" id="telegramChatIdInput">
            <input type="hidden" id="telegramChatTitleInput">

            <div class="rounded-2xl border border-sky-200 bg-sky-50 p-4">
              <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-xs uppercase font-extrabold text-sky-800 tracking-wider">Kết nối Telegram</span>
                    <span id="telegramConnectBadge" class="px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-100 text-amber-700">CHƯA KẾT NỐI</span>
                  </div>
                  <p id="telegramConnectTitle" class="text-sm font-bold text-slate-800 truncate">Chưa chọn group/channel</p>
                  <p id="telegramConnectId" class="text-[11px] text-slate-500 font-mono mt-1"></p>
                </div>
                <button type="button" id="telegramConnectBtn" onclick="startTelegramCourseConnect()" class="shrink-0 px-4 py-3 bg-sky-600 hover:bg-sky-700 text-white font-black rounded-xl transition text-sm shadow-sm">
                  Kết nối Telegram
                </button>
              </div>
              <p id="telegramConnectHelp" class="text-[11px] text-slate-500 mt-3">Lưu khóa học trước, sau đó bấm Kết nối Telegram. Bot sẽ cho bạn chọn group hoặc channel và tự lưu Chat ID.</p>
            </div>

            <div>
              <label class="block text-xs uppercase font-extrabold text-slate-500 tracking-wider mb-2">Link xin gia nhập hết hạn sau (giờ)</label>
              <input type="number" id="telegramInviteTtlInput" min="1" max="720" value="72" class="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-pink-500 transition text-sm">
              <p class="text-[11px] text-slate-400 mt-1">Mỗi order sẽ được bot tạo một link xin gia nhập riêng; mặc định 72 giờ.</p>
            </div>
          </div>
`;

replaceBetween(
  '          <div id="telegramCourseFields" class="hidden mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">',
  '        </div>\n\n        <!-- BANK PAYMENT SETTINGS SECTION -->',
  telegramFields,
  'telegram fields'
);

const telegramFunctions = `    function updateTelegramConnectUi() {
      const mode = document.getElementById('courseDeliveryModeInput')?.value || 'lms';
      const courseId = document.getElementById('courseId')?.value || '';
      const chatId = document.getElementById('telegramChatIdInput')?.value || '';
      const chatTitle = document.getElementById('telegramChatTitleInput')?.value || '';
      const badge = document.getElementById('telegramConnectBadge');
      const title = document.getElementById('telegramConnectTitle');
      const idText = document.getElementById('telegramConnectId');
      const button = document.getElementById('telegramConnectBtn');
      const help = document.getElementById('telegramConnectHelp');
      if (!badge || !title || !idText || !button || !help) return;

      if (mode !== 'telegram') return;
      if (chatId) {
        badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-700';
        badge.innerText = 'ĐÃ KẾT NỐI';
        title.innerText = chatTitle || 'Telegram đã kết nối';
        idText.innerText = 'Chat ID: ' + chatId;
        button.innerText = 'Đổi group/channel';
        button.disabled = false;
        button.classList.remove('opacity-50', 'cursor-not-allowed');
        help.innerText = 'Có thể kết nối lại nếu bạn muốn chuyển khóa học sang group/channel khác.';
      } else {
        badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-100 text-amber-700';
        badge.innerText = courseId ? 'SẴN SÀNG KẾT NỐI' : 'CHƯA LƯU';
        title.innerText = 'Chưa chọn group/channel';
        idText.innerText = '';
        button.innerText = 'Kết nối Telegram';
        button.disabled = !courseId;
        button.classList.toggle('opacity-50', !courseId);
        button.classList.toggle('cursor-not-allowed', !courseId);
        help.innerText = courseId
          ? 'Bấm Kết nối Telegram → mở bot → chọn group hoặc channel. Hệ thống tự lưu Chat ID.'
          : 'Hãy lưu khóa học trước. Sau khi có ID khóa học, nút kết nối sẽ được bật.';
      }
    }

    function toggleTelegramFields() {
      const mode = document.getElementById('courseDeliveryModeInput')?.value || 'lms';
      const box = document.getElementById('telegramCourseFields');
      if (!box) return;
      box.classList.toggle('hidden', mode !== 'telegram');
      const chatId = document.getElementById('telegramChatIdInput');
      if (chatId) chatId.required = false;
      updateTelegramConnectUi();
    }

    let telegramConnectPollTimer = null;

    async function pollTelegramCourseConnect(courseId, attempts = 0) {
      if (!courseId || attempts > 90) {
        if (telegramConnectPollTimer) clearTimeout(telegramConnectPollTimer);
        telegramConnectPollTimer = null;
        return;
      }
      try {
        const response = await fetch('/api/telegram-connect?courseId=' + encodeURIComponent(courseId), {
          headers: { 'X-Admin-Password': currentAdminPassword }
        });
        const data = await response.json();
        if (response.ok && data.connected) {
          document.getElementById('telegramChatIdInput').value = data.telegramChatId || '';
          document.getElementById('telegramChatTitleInput').value = data.telegramChatTitle || '';
          updateTelegramConnectUi();
          if (telegramConnectPollTimer) clearTimeout(telegramConnectPollTimer);
          telegramConnectPollTimer = null;
          showToast('Kết nối Telegram thành công!');
          await loadCourses();
          return;
        }
      } catch (error) {
        console.warn('[telegram-connect] poll failed', error);
      }
      telegramConnectPollTimer = setTimeout(() => pollTelegramCourseConnect(courseId, attempts + 1), 2000);
    }

    async function startTelegramCourseConnect() {
      const courseId = document.getElementById('courseId')?.value || '';
      if (!courseId) {
        showToast('Hãy lưu khóa học trước khi kết nối Telegram.');
        return;
      }

      const popup = window.open('', '_blank');
      const button = document.getElementById('telegramConnectBtn');
      const badge = document.getElementById('telegramConnectBadge');
      if (button) {
        button.disabled = true;
        button.innerText = 'Đang mở Telegram...';
      }
      if (badge) {
        badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-black bg-sky-100 text-sky-700';
        badge.innerText = 'ĐANG CHỜ';
      }

      try {
        const response = await fetch('/api/telegram-connect', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Password': currentAdminPassword
          },
          body: JSON.stringify({ courseId })
        });
        const data = await response.json();
        if (!response.ok || !data.connectUrl) throw new Error(data.error || 'Không tạo được link kết nối Telegram');

        if (popup) popup.location.href = data.connectUrl;
        else window.location.href = data.connectUrl;

        showToast('Telegram đã mở. Hãy bấm START rồi chọn group/channel.');
        if (telegramConnectPollTimer) clearTimeout(telegramConnectPollTimer);
        telegramConnectPollTimer = setTimeout(() => pollTelegramCourseConnect(courseId, 0), 1500);
      } catch (error) {
        if (popup) popup.close();
        alert('Không thể bắt đầu kết nối Telegram: ' + (error.message || error));
        updateTelegramConnectUi();
      }
    }

`;

replaceBetween(
  '    function toggleTelegramFields() {',
  '    function openCourseModal(course = null) {',
  telegramFunctions,
  'telegram functions'
);

text = text.replace(
  '        document.getElementById("telegramInviteTtlInput").value = course.telegramInviteTtlHours || 72;\n        toggleTelegramFields();',
  '        document.getElementById("telegramInviteTtlInput").value = course.telegramInviteTtlHours || 72;\n        toggleTelegramFields();\n        updateTelegramConnectUi();'
);

text = text.replace(
  '        document.getElementById("telegramInviteTtlInput").value = 72;\n        toggleTelegramFields();',
  '        document.getElementById("telegramInviteTtlInput").value = 72;\n        toggleTelegramFields();\n        updateTelegramConnectUi();'
);

const oldSuccess = `        if (response.ok) {
          showToast(id ? "Đã cập nhật khóa học" : "Đã tạo khóa học mới thành công");
          closeCourseModal();
          loadCourses();
        } else {`;

const newSuccess = `        if (response.ok) {
          const savedCourseId = data?.data?.id || id;
          if (savedCourseId) document.getElementById("courseId").value = savedCourseId;
          if (deliveryMode === 'telegram' && !telegramChatId && savedCourseId) {
            showToast(id ? "Đã cập nhật khóa. Bây giờ hãy kết nối Telegram." : "Đã tạo khóa. Bây giờ hãy kết nối Telegram.");
            updateTelegramConnectUi();
            await loadCourses();
          } else {
            showToast(id ? "Đã cập nhật khóa học" : "Đã tạo khóa học mới thành công");
            closeCourseModal();
            loadCourses();
          }
        } else {`;

if (!text.includes(oldSuccess)) throw new Error('Missing course save success block');
text = text.replace(oldSuccess, newSuccess);

fs.writeFileSync(path, text);
console.log('Patched admin.html for one-click Telegram connection');
