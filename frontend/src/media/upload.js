import { AuthError, getCsrfToken } from '../lib/api.js';

// Multipart upload with progress (fetch has no upload progress, XHR does).
// Resolves with the server's JSON; rejects with AuthError on 401, or an Error
// carrying the server's message.
export function uploadFile(url, file, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-CSRF-Token', getCsrfToken());
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 401) reject(new AuthError('unauthorized'));
      else if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('network error during upload'));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

const VIDEO_EXT = /\.(mp4|m4v|mkv|mov|webm)$/i;
export const isVideoFile = (file) => String(file?.type || '').startsWith('video/') || VIDEO_EXT.test(file?.name || '');

export const IMAGE_ACCEPT = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp';
export const VIDEO_ACCEPT = '.mp4,.m4v,.mkv,.mov,.webm,video/*';
