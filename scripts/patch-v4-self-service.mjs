import fs from 'node:fs';

function replaceOnce(text, from, to, label) {
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`);
  return text.replace(from, to);
}

// 1) Checkout: V4 goes to its own course manager, never directly into player.
{
  const file = 'index.html';
  let text = fs.readFileSync(file, 'utf8');
  const from = `          if(data.deliveryMode==='v4'){
            console.log('[Checkout] redirecting to V4 Web entry');
            const courseSlug=data.course||new URLSearchParams(window.location.search).get('course')||'';
            window.location.href=targetLmsUrl+'/v4-entry.html?course='+encodeURIComponent(courseSlug);
          }else{
            console.log('[Checkout] redirecting to original student portal');
            window.location.href = 'https://yeunauan.live/my-courses';
          }`;
  const to = `          if(data.deliveryMode==='v4'){
            console.log('[Checkout] redirecting to V4 course manager');
            const courseSlug=data.course||new URLSearchParams(window.location.search).get('course')||'';
            const managerPath=data.managerPath||('/my-courses.html?registered=1&course='+encodeURIComponent(courseSlug));
            window.location.href=managerPath.startsWith('http')?managerPath:(targetLmsUrl+managerPath);
          }else{
            console.log('[Checkout] redirecting to original student portal');
            window.location.href = 'https://yeunauan.live/my-courses';
          }`;
  text = replaceOnce(text, from, to, 'checkout V4 redirect');
  fs.writeFileSync(file, text);
}

// 2) Admin: source selector + mapping save for V4.
{
  const file = 'admin.html';
  let text = fs.readFileSync(file, 'utf8');

  const selectBlock = `          <select id="courseDeliveryModeInput" onchange="toggleTelegramFields()" class="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-pink-500 transition text-sm">
            <option value="lms">Học trên hệ thống LMS</option>
            <option value="v4">Học trên V4 Web</option>
            <option value="telegram">Học trên Telegram</option>
          </select>
          <div id="telegramCourseFields" class="hidden mt-4 space-y-4">`;
  const selectWithV4 = `          <select id="courseDeliveryModeInput" onchange="toggleTelegramFields()" class="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-pink-500 transition text-sm">
            <option value="lms">Học trên hệ thống LMS</option>
            <option value="v4">Học trên V4 Web</option>
            <option value="telegram">Học trên Telegram</option>
          </select>

          <div id="v4CourseFields" class="hidden mt-4 space-y-3">
            <div class="rounded-2xl border border-violet-200 bg-violet-50 p-4">
              <div class="flex items-center justify-between gap-3 mb-2">
                <div>
                  <label class="block text-xs uppercase font-extrabold text-violet-700 tracking-wider">Nguồn nội dung V4</label>
                  <p class="text-[11px] text-slate-500 mt-1">Chọn kênh Telegram đã đăng ký/index. Mỗi khóa V4 có thể dùng một nguồn riêng.</p>
                </div>
                <button type="button" onclick="loadV4Sources(true)" class="shrink-0 px-3 py-2 bg-white border border-violet-200 text-violet-700 rounded-xl text-[11px] font-black hover:bg-violet-100 transition">Làm mới</button>
              </div>
              <select id="v4SourceInput" onchange="updateV4SourceHelp()" class="w-full px-4 py-3 bg-white border border-violet-200 rounded-xl outline-none focus:border-violet-500 transition text-sm">
                <option value="">Đang tải nguồn Telegram...</option>
              </select>
              <p id="v4SourceHelp" class="text-[11px] text-slate-500 mt-2">Nguồn phải có ít nhất 1 bài đã index trước khi chuyển khóa sang Sẵn sàng.</p>
              <div class="mt-3 flex flex-wrap gap-2">
                <a href="https://telegram-channel-cloner.vercel.app/" target="_blank" rel="noopener" class="inline-flex px-3 py-2 bg-violet-600 text-white rounded-xl text-[11px] font-black hover:bg-violet-700 transition">Mở quản trị nguồn Telegram</a>
                <span class="text-[10px] text-slate-400 self-center">Kênh cũ vẫn tiếp tục index live dù không còn là MASTER.</span>
              </div>
            </div>
          </div>

          <div id="telegramCourseFields" class="hidden mt-4 space-y-4">`;
  text = replaceOnce(text, selectBlock, selectWithV4, 'V4 source fields');

  text = replaceOnce(
    text,
    `    let allCourses = [];
    let currentAdminPassword = "";`,
    `    let allCourses = [];
    let currentAdminPassword = "";
    let v4Sources = [];`,
    'V4 source state'
  );

  const marker = `    // 7. COURSE MODAL ACTIONS (OPEN / CLOSE / SUBMIT)
    function updateTelegramConnectUi() {`;
  const functions = `    // 7. COURSE MODAL ACTIONS (OPEN / CLOSE / SUBMIT)
    async function loadV4Sources(force = false) {
      const select = document.getElementById('v4SourceInput');
      const help = document.getElementById('v4SourceHelp');
      if (!select || !currentAdminPassword) return;
      const previous = select.value;
      const courseSlug = document.getElementById('courseSlugInput')?.value.trim() || '';
      if (force || !v4Sources.length) {
        select.innerHTML = '<option value="">Đang tải nguồn Telegram...</option>';
      }
      try {
        const query = courseSlug ? ('?courseSlug=' + encodeURIComponent(courseSlug)) : '';
        const response = await fetch('/api/v4-sources' + query, {
          cache: 'no-store',
          headers: { 'X-Admin-Password': currentAdminPassword }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Không tải được nguồn V4');
        v4Sources = Array.isArray(data.sources) ? data.sources : [];
        const mappedSourceId = data.mapping?.source_id || '';
        const selected = mappedSourceId || previous;
        if (!v4Sources.length) {
          select.innerHTML = '<option value="">Chưa có nguồn Telegram nào — mở Cloner để đăng ký</option>';
        } else {
          select.innerHTML = '<option value="">— Chọn nguồn nội dung V4 —</option>' + v4Sources.map(source => {
            const count = Number(source.indexed_message_count || 0);
            const title = source.title || (source.username ? '@' + source.username : source.chat_id) || source.id;
            const master = source.active ? ' · MASTER' : '';
            return '<option value="' + escapeAttr(source.id) + '">' + escapeAttr(title) + ' · ' + count + ' bài' + master + '</option>';
          }).join('');
        }
        if (selected && v4Sources.some(source => source.id === selected)) select.value = selected;
        updateV4SourceHelp();
      } catch (error) {
        console.error('[v4-sources] load failed', error);
        select.innerHTML = '<option value="">Không tải được nguồn V4</option>';
        if (help) help.innerText = error.message || 'Không tải được nguồn V4';
      }
    }

    function updateV4SourceHelp() {
      const select = document.getElementById('v4SourceInput');
      const help = document.getElementById('v4SourceHelp');
      if (!select || !help) return;
      const source = v4Sources.find(item => item.id === select.value);
      if (!source) {
        help.innerText = 'Chọn một nguồn Telegram đã đăng ký. Nguồn phải có ít nhất 1 bài đã index trước khi chuyển khóa sang Sẵn sàng.';
        return;
      }
      const count = Number(source.indexed_message_count || 0);
      const courses = Array.isArray(source.mappedCourses) && source.mappedCourses.length
        ? ' · đang dùng: ' + source.mappedCourses.join(', ')
        : '';
      help.innerText = (count > 0 ? '✓ ' : '⚠ ') + count + ' bài đã index' + (source.active ? ' · MASTER hiện tại' : ' · nguồn đã đăng ký') + courses;
    }

    function updateTelegramConnectUi() {`;
  text = replaceOnce(text, marker, functions, 'V4 source functions');

  const oldToggle = `    function toggleTelegramFields() {
      const mode = document.getElementById('courseDeliveryModeInput')?.value || 'lms';
      const box = document.getElementById('telegramCourseFields');
      if (!box) return;
      box.classList.toggle('hidden', mode !== 'telegram');
      const chatId = document.getElementById('telegramChatIdInput');
      if (chatId) chatId.required = false;
      updateTelegramConnectUi();
    }`;
  const newToggle = `    function toggleTelegramFields() {
      const mode = document.getElementById('courseDeliveryModeInput')?.value || 'lms';
      const box = document.getElementById('telegramCourseFields');
      const v4Box = document.getElementById('v4CourseFields');
      if (box) box.classList.toggle('hidden', mode !== 'telegram');
      if (v4Box) v4Box.classList.toggle('hidden', mode !== 'v4');
      const chatId = document.getElementById('telegramChatIdInput');
      if (chatId) chatId.required = false;
      updateTelegramConnectUi();
      if (mode === 'v4') loadV4Sources(false);
    }`;
  text = replaceOnce(text, oldToggle, newToggle, 'delivery field toggle');

  text = replaceOnce(
    text,
    `      const telegramInviteTtlHours = parseInt(document.getElementById("telegramInviteTtlInput").value, 10) || 72;
      
      // Bank configurations`,
    `      const telegramInviteTtlHours = parseInt(document.getElementById("telegramInviteTtlInput").value, 10) || 72;
      const v4SourceId = document.getElementById("v4SourceInput")?.value || "";
      
      // Bank configurations`,
    'submit V4 source variable'
  );

  text = replaceOnce(
    text,
    `      const qrImageUrl = document.getElementById("qrImageUrlInput").value.trim();

      const payload = {`,
    `      const qrImageUrl = document.getElementById("qrImageUrlInput").value.trim();

      if (deliveryMode === 'v4' && !v4SourceId) {
        alert('Vui lòng chọn Nguồn nội dung V4 trước khi lưu khóa học. Nếu chưa có nguồn, mở trang quản trị Telegram để đăng ký/index kênh trước.');
        return;
      }

      const payload = {`,
    'submit V4 source validation'
  );

  text = replaceOnce(
    text,
    `          const savedCourseId = data?.data?.id || id;
          if (savedCourseId) document.getElementById("courseId").value = savedCourseId;
          if (deliveryMode === 'telegram' && !telegramChatId && savedCourseId) {`,
    `          const savedCourseId = data?.data?.id || id;
          if (savedCourseId) document.getElementById("courseId").value = savedCourseId;

          if (deliveryMode === 'v4') {
            const mappingResponse = await fetch('/api/v4-sources', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Password': currentAdminPassword
              },
              body: JSON.stringify({ courseSlug: slug, sourceId: v4SourceId })
            });
            const mappingData = await mappingResponse.json().catch(() => ({}));
            if (!mappingResponse.ok) {
              alert(mappingData.error || 'Khóa học đã lưu nhưng chưa gắn được nguồn V4. Hãy thử lại trước khi chuyển Sẵn sàng.');
              await loadCourses();
              await loadV4Sources(true);
              return;
            }
          } else if (id) {
            fetch('/api/v4-sources', {
              method: 'DELETE',
              headers: {
                'Content-Type': 'application/json',
                'X-Admin-Password': currentAdminPassword
              },
              body: JSON.stringify({ courseSlug: slug })
            }).catch(() => {});
          }

          if (deliveryMode === 'telegram' && !telegramChatId && savedCourseId) {`,
    'save V4 source mapping'
  );

  const publishText = `      const message = nextPublished
        ? \`Bạn có chắc muốn chuyển khóa "\${courseName}" sang trạng thái Sẵn sàng không?\\nHọc viên có quyền học sẽ thấy nút Vào học ngay nếu bài học đã đồng bộ sang Portal.\`
        : \`Bạn có chắc muốn chuyển khóa "\${courseName}" sang trạng thái Chờ lên bài không?\\nHọc viên sẽ chưa vào học được cho đến khi khóa được chuyển lại Sẵn sàng.\`;`;
  const publishReplacement = `      const isV4 = String(course.deliveryMode || '').toLowerCase() === 'v4';
      const message = nextPublished
        ? (isV4
          ? \`Bạn có chắc muốn chuyển khóa "\${courseName}" sang trạng thái Sẵn sàng không?\\nHệ thống sẽ chỉ cho phép nếu nguồn Telegram V4 đã được gắn và có bài đã index.\`
          : \`Bạn có chắc muốn chuyển khóa "\${courseName}" sang trạng thái Sẵn sàng không?\\nHọc viên có quyền học sẽ thấy nút Vào học ngay nếu bài học đã đồng bộ sang Portal.\`)
        : \`Bạn có chắc muốn chuyển khóa "\${courseName}" sang trạng thái Chờ lên bài không?\\nHọc viên sẽ chưa vào học được cho đến khi khóa được chuyển lại Sẵn sàng.\`;`;
  text = replaceOnce(text, publishText, publishReplacement, 'publish confirmation');

  // Add delivery-mode badge to each admin card for quick visual checking.
  text = replaceOnce(
    text,
    `                <p class="text-slate-500 text-xs line-clamp-2 mt-1 mb-4">
                  \${course.description || "Chưa có mô tả ngắn."}
                </p>`,
    `                <p class="text-slate-500 text-xs line-clamp-2 mt-1 mb-2">
                  \${course.description || "Chưa có mô tả ngắn."}
                </p>
                <div class="mb-4"><span class="inline-flex px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider \${course.deliveryMode === 'v4' ? 'bg-violet-100 text-violet-700' : course.deliveryMode === 'telegram' ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-600'}">\${course.deliveryMode === 'v4' ? 'V4 WEB' : course.deliveryMode === 'telegram' ? 'TELEGRAM' : 'LMS'}</span></div>`,
    'delivery mode badge'
  );

  fs.writeFileSync(file, text);
}

console.log('V4 self-service UI patch applied');
