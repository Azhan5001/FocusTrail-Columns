// Shared, display-independent validation for the Shell/helper boundary.
export const MAX_DRAG_FILES = 512;
export const MAX_REQUEST_BYTES = 1024 * 1024;

export function parseDragRequest(text) {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_REQUEST_BYTES)
        throw new Error('The drag selection is too large. Select fewer files.');
    const request = JSON.parse(text);
    if (request?.version !== 1 || !Array.isArray(request.uris) ||
        !request.uris.length || request.uris.length > MAX_DRAG_FILES)
        throw new Error(`Select between 1 and ${MAX_DRAG_FILES} files.`);
    for (const uri of request.uris) {
        if (typeof uri !== 'string' || !uri.startsWith('file:///') ||
            /[\u0000-\u0020\u007f]/u.test(uri) || uri.length > 32768)
            throw new Error('Drag files must have local file URIs. Copy remote files locally first.');
    }
    return [...new Set(request.uris)];
}

export function serializeUriList(uris) {
    const validated = parseDragRequest(JSON.stringify({version: 1, uris}));
    return `${validated.join('\r\n')}\r\n`;
}
