from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)


# index.html
p = Path('index.html')
s = p.read_text()
s = replace_once(
    s,
    '''  <p class="mt-4 text-[#7a675c] text-base sm:text-lg leading-relaxed font-bold">
    Đăng ký nhanh bằng Gmail, chuyển khoản và gửi bill xác nhận.
    Admin kiểm tra thanh toán và cấp quyền học trong vòng 24 giờ.
  </p>''',
    '''  <p id="courseIntroCopy" class="mt-4 text-[#7a675c] text-base sm:text-lg leading-relaxed font-bold">
    Đăng ký nhanh bằng Gmail, chuyển khoản và gửi bill xác nhận.
    Admin kiểm tra thanh toán và cấp quyền học trong vòng 24 giờ.
  </p>''',
    'course intro',
)
s = replace_once(
    s,
    '<p class="mt-5 text-white/78 text-base sm:text-lg font-bold leading-relaxed">Sau khi thanh toán, nhập Gmail nhận khóa học và upload ảnh bill. Admin sẽ kiểm tra và cấp quyền học trong vòng 24 giờ.</p>',
    '<p id="registerIntroCopy" class="mt-5 text-white/78 text-base sm:text-lg font-bold leading-relaxed">Sau khi thanh toán, nhập Gmail nhận khóa học và upload ảnh bill. Admin sẽ kiểm tra và cấp quyền học trong vòng 24 giờ.</p>',
    'register intro',
)
s = replace_once(
    s,
    '<label class="block font-black mb-2 text-[#241712] uppercase tracking-wider text-sm">Gmail nhận khóa học</label><input type="email" id="gmail" required class="input-pin w-full rounded-[24px] p-4 text-lg font-bold" placeholder="Nhập Gmail của bạn">',
    '<label id="contactLabel" class="block font-black mb-2 text-[#241712] uppercase tracking-wider text-sm">Gmail nhận khóa học</label><input type="email" id="gmail" required autocomplete="email" class="input-pin w-full rounded-[24px] p-4 text-lg font-bold" placeholder="Nhập Gmail của bạn">',
    'contact field',
)
s = replace_once(
    s,
    '<p class="text-sm text-black/55 text-center leading-relaxed font-bold">Gmail của bạn sẽ được cấp quyền truy cập thư mục khóa học sau khi xác nhận thanh toán.</p>',
    '<p id="registerFootnote" class="text-sm text-black/55 text-center leading-relaxed font-bold">Gmail của bạn sẽ được cấp quyền truy cập thư mục khóa học sau khi xác nhận thanh toán.</p>',
    'register footnote',
)
s = replace_once(
    s,
    "const data=await res.json();window.currentCourseName=data.courseName||'';",
    "const data=await res.json();window.currentDeliveryMode=data.deliveryMode==='telegram'?'telegram':'lms';window.currentCourseName=data.courseName||'';",
    'delivery mode state',
)
s = replace_once(
    s,
    "document.getElementById('pricePayment').innerText=data.price||'';document.getElementById('transferNote').innerText=data.transferNote||'';if(data.qrImageUrl",
    "document.getElementById('pricePayment').innerText=data.price||'';applyDeliveryCopy(data);if(data.qrImageUrl",
    'loadConfig transfer note',
)
marker = "async function loadConfig(){try{"
delivery_fn = '''function applyDeliveryCopy(data){
  const isTelegram=data&&data.deliveryMode==='telegram';
  const contactInput=document.getElementById('gmail');
  const courseIntro=document.getElementById('courseIntroCopy');
  const registerIntro=document.getElementById('registerIntroCopy');
  const contactLabel=document.getElementById('contactLabel');
  const footnote=document.getElementById('registerFootnote');
  if(isTelegram){
    if(courseIntro) courseIntro.innerText='Đăng ký nhanh bằng Telegram, chuyển khoản và gửi bill xác nhận. Admin kiểm tra thanh toán và duyệt quyền tham gia khóa học trên Telegram trong vòng 24 giờ.';
    if(registerIntro) registerIntro.innerText='Sau khi thanh toán, nhập nick Telegram của bạn và upload ảnh bill. Admin sẽ kiểm tra và duyệt quyền tham gia khóa học trên Telegram trong vòng 24 giờ.';
    if(contactLabel) contactLabel.innerText='Telegram nhận khóa học';
    if(contactInput){contactInput.type='text';contactInput.placeholder='Nhập nick Telegram của bạn';contactInput.autocomplete='off';contactInput.inputMode='text';}
    if(footnote) footnote.innerText='Nick Telegram của bạn sẽ được dùng để đối chiếu và duyệt vào nhóm/kênh khóa học sau khi xác nhận thanh toán.';
    document.getElementById('transferNote').innerText='Tên Nick Telegram của bạn';
  }else{
    if(courseIntro) courseIntro.innerText='Đăng ký nhanh bằng Gmail, chuyển khoản và gửi bill xác nhận. Admin kiểm tra thanh toán và cấp quyền học trong vòng 24 giờ.';
    if(registerIntro) registerIntro.innerText='Sau khi thanh toán, nhập Gmail nhận khóa học và upload ảnh bill. Admin sẽ kiểm tra và cấp quyền học trong vòng 24 giờ.';
    if(contactLabel) contactLabel.innerText='Gmail nhận khóa học';
    if(contactInput){contactInput.type='email';contactInput.placeholder='Nhập Gmail của bạn';contactInput.autocomplete='email';contactInput.inputMode='email';}
    if(footnote) footnote.innerText='Gmail của bạn sẽ được cấp quyền truy cập thư mục khóa học sau khi xác nhận thanh toán.';
    document.getElementById('transferNote').innerText=data.transferNote||'';
  }
}
'''
if s.count(marker) != 1:
    raise SystemExit(f'loadConfig marker: expected 1 match, got {s.count(marker)}')
s = s.replace(marker, delivery_fn + marker, 1)
s = replace_once(
    s,
    "  const gmail=document.getElementById('gmail').value.trim();\n  const file=document.getElementById('bill').files[0];",
    "  const contact=document.getElementById('gmail').value.trim();\n  const isTelegram=window.currentDeliveryMode==='telegram';\n  if(!contact){\n    alert(isTelegram?'Vui lòng nhập nick Telegram của bạn':'Vui lòng nhập Gmail của bạn');\n    btn.disabled=false;\n    btn.innerText='GỬI ĐĂNG KÝ';\n    return;\n  }\n  if(isTelegram&&(contact.length<2||contact.length>64)){\n    alert('Nick Telegram phải từ 2 đến 64 ký tự');\n    btn.disabled=false;\n    btn.innerText='GỬI ĐĂNG KÝ';\n    return;\n  }\n  const gmail=isTelegram?'':contact;\n  const telegramNick=isTelegram?contact:'';\n  const file=document.getElementById('bill').files[0];",
    'submit contact logic',
)
s = replace_once(
    s,
    "          gmail,\n          billName:file.name,",
    "          gmail,\n          telegramNick,\n          billName:file.name,",
    'submit payload',
)
p.write_text(s)

# api/register.js
p = Path('api/register.js')
s = p.read_text()
s = replace_once(
    s,
    "const normalizeEmail = email => String(email || '').trim().toLowerCase();\nconst isValidEmail = email => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) && !/[^\\x00-\\x7F]/.test(email);",
    "const normalizeEmail = email => String(email || '').trim().toLowerCase();\nconst isValidEmail = email => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) && !/[^\\x00-\\x7F]/.test(email);\nconst normalizeTelegramNick = value => String(value || '').trim().replace(/\\s+/g, ' ');\nconst isValidTelegramNick = value => value.length >= 2 && value.length <= 64 && !/[\\x00-\\x1F\\x7F]/.test(value);",
    'register helpers',
)
s = replace_once(
    s,
    "    const { gmail, billName, billType, billData, course } = req.body || {};\n    const cleanEmail = normalizeEmail(gmail);",
    "    const { gmail, telegramNick, billName, billType, billData, course } = req.body || {};\n    const cleanEmail = normalizeEmail(gmail);\n    const cleanTelegramNick = normalizeTelegramNick(telegramNick);",
    'register request contact',
)
s = replace_once(
    s,
    "    if (!cleanEmail || !billName || !cleanBillType || !cleanBillData) return res.status(400).json({ error: 'Thiếu dữ liệu' });\n    if (!isValidEmail(cleanEmail)) return res.status(400).json({ error: 'Địa chỉ email không hợp lệ' });",
    "    if (!billName || !cleanBillType || !cleanBillData) return res.status(400).json({ error: 'Thiếu dữ liệu' });",
    'register early email validation',
)
anchor = "    if (deliveryMode === 'telegram' && !telegramChatId) {\n      return res.status(409).json({ error: 'Khóa học Telegram đang chờ Admin kết nối group/channel. Vui lòng thử lại sau.' });\n    }\n"
insert = anchor + "\n    if (deliveryMode === 'telegram') {\n      if (!cleanTelegramNick) return res.status(400).json({ error: 'Vui lòng nhập nick Telegram của bạn' });\n      if (!isValidTelegramNick(cleanTelegramNick)) return res.status(400).json({ error: 'Nick Telegram phải từ 2 đến 64 ký tự' });\n    } else {\n      if (!cleanEmail) return res.status(400).json({ error: 'Vui lòng nhập Gmail của bạn' });\n      if (!isValidEmail(cleanEmail)) return res.status(400).json({ error: 'Địa chỉ email không hợp lệ' });\n    }\n"
s = replace_once(s, anchor, insert, 'register mode contact validation')
s = replace_once(
    s,
    '      customer_email: cleanEmail,',
    "      customer_email: deliveryMode === 'lms' ? cleanEmail : null,\n      telegram_claimed_username: deliveryMode === 'telegram' ? cleanTelegramNick : null,",
    'register order contact fields',
)
s = replace_once(
    s,
    "      raw_data: { billName: String(billName).slice(0, 120), billType: cleanBillType }",
    "      raw_data: { billName: String(billName).slice(0, 120), billType: cleanBillType, contactType: deliveryMode === 'telegram' ? 'telegram' : 'email', ...(deliveryMode === 'telegram' ? { telegramClaimedUsername: cleanTelegramNick } : {}) }",
    'register raw contact',
)
p.write_text(s)

# utils/telegram.js
p = Path('utils/telegram.js')
s = p.read_text()
s = replace_once(
    s,
    "    `Email: ${order.customer_email}`,\n    `Telegram: ${from?.first_name || ''} ${username}`,",
    "    `Nick Telegram khách khai báo: ${order.telegram_claimed_username || '(không có)'}`,\n    `Telegram thực tế: ${from?.first_name || ''} ${username}`,",
    'telegram admin notification contact',
)
p.write_text(s)

# api/orders.js
p = Path('api/orders.js')
s = p.read_text()
s = replace_once(
    s,
    "          'Gmail': o.customer_email, gmail: o.customer_email, 'Link bill': o.proof_image_url, billLink: o.proof_image_url,",
    "          'Gmail': o.customer_email || '', gmail: o.customer_email || '', 'Telegram khai báo': o.telegram_claimed_username || '', telegramClaimedUsername: o.telegram_claimed_username || '', 'Link bill': o.proof_image_url, billLink: o.proof_image_url,",
    'orders contact mapping',
)
s = replace_once(
    s,
    "          delivery_mode: o.delivery_mode || 'lms', telegram_chat_id: o.telegram_chat_id || '',",
    "          delivery_mode: o.delivery_mode || 'lms', telegram_claimed_username: o.telegram_claimed_username || '', telegram_chat_id: o.telegram_chat_id || '',",
    'orders telegram claimed field',
)
p.write_text(s)
