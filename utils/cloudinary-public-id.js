export function extractCloudinaryBillPublicId(value, courseSlug) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const uploadIndex = parts.indexOf('upload');
    if (uploadIndex < 0) return null;
    const assetParts = parts.slice(uploadIndex + 1);
    if (/^v\d+$/.test(assetParts[0] || '')) assetParts.shift();
    const publicId = assetParts.join('/').replace(/\.[^./]+$/, '');
    const expectedPrefix = `bill-chuyen-khoan/${String(courseSlug || '').trim()}/`;
    return publicId.startsWith(expectedPrefix) ? publicId : null;
  } catch {
    return null;
  }
}
