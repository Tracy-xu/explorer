import http from 'http';
import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import mime from 'mime';
import crypto from 'crypto';
import zlib from 'zlib';
export default class StaticServer {
    config;
    server;
    constructor(config) {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        this.config = {
            port: 3000,
            root: path.join(__dirname, 'public'),
            index: 'index.html',
            ...config
        };
        this.server = http.createServer(this.handleRequest.bind(this));
    }
    async getPathStats(requestPath) {
        try {
            return await fsp.stat(requestPath);
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return null;
            throw err;
        }
    }
    getRequestPath(req) {
        if (!req.url || !req.headers.host)
            return null;
        const reqUrl = new URL(req.url, `http://${req.headers.host}`);
        let requestPath = path.join(this.config.root, decodeURIComponent(reqUrl.pathname));
        requestPath = path.normalize(requestPath);
        return requestPath.startsWith(this.config.root) ? requestPath : null;
    }
    async getETag(filePath, stats) {
        if (stats.size < 1024 * 1024) {
            const content = await fsp.readFile(filePath);
            return crypto.createHash('md5').update(content).digest('hex');
        }
        return crypto.createHash('md5').update(`${stats.size}-${stats.mtime.getTime()}`).digest('hex');
    }
    parseRange(range, size) {
        const parts = range.replace(/bytes=/, '').split('-');
        let start = parseInt(parts[0], 10);
        let end = parseInt(parts[1], 10);
        if (isNaN(start)) {
            start = size - end;
            end = size - 1;
        }
        else if (isNaN(end)) {
            end = size - 1;
        }
        return start >= size || end >= size ? null : { start, end };
    }
    shouldCompress(req, filePath) {
        const acceptEncoding = req.headers['accept-encoding'];
        if (!acceptEncoding?.includes('gzip'))
            return false;
        const compressibleExtensions = ['.html', '.htm', '.css', '.js', '.json', '.xml', '.txt', '.svg', '.webmanifest'];
        const ext = path.extname(filePath).toLowerCase();
        return compressibleExtensions.includes(ext);
    }
    sendErrorResponse(res, statusCode, message) {
        res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
        res.end(message);
    }
    async getResponseHeaders(req, filePath, stats) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = mime.getType(filePath) || 'application/octet-stream';
        const etag = await this.getETag(filePath, stats);
        const lastModified = stats.mtime.toUTCString();
        const isCached = req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === lastModified;
        const headers = {
            'Content-Type': mimeType,
            ETag: etag,
            'Last-Modified': lastModified,
            'Cache-Control': ext === '.html' ? 'no-cache, must-revalidate' : 'public, max-age=31536000, immutable',
            'Accept-Ranges': 'bytes'
        };
        return { headers, isCached };
    }
    compressStream(stream) {
        const gzip = zlib.createGzip();
        return stream.pipe(gzip);
    }
    sendRangeResponse(req, res, filePath, headers, stats) {
        const rangeVal = this.parseRange(req.headers.range, stats.size);
        if (!rangeVal) {
            this.sendErrorResponse(res, 416, 'Range Not Satisfiable');
            return;
        }
        const { start, end } = rangeVal;
        headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`;
        headers['Content-Length'] = String(end - start + 1);
        res.writeHead(206, headers);
        const fileStream = fs.createReadStream(filePath, { start, end });
        if (this.shouldCompress(req, filePath)) {
            headers['Content-Encoding'] = 'gzip';
            this.compressStream(fileStream).pipe(res);
        }
        else {
            fileStream.pipe(res);
        }
    }
    sendFileResponse(req, res, filePath, headers, stats) {
        const fileStream = fs.createReadStream(filePath);
        if (this.shouldCompress(req, filePath)) {
            headers['Content-Encoding'] = 'gzip';
            res.writeHead(200, headers);
            this.compressStream(fileStream).pipe(res);
        }
        else {
            headers['Content-Length'] = String(stats.size);
            res.writeHead(200, headers);
            fileStream.pipe(res);
        }
    }
    async generateDirectoryIndex(directoryPath, reqUrl) {
        try {
            const files = await fsp.readdir(directoryPath);
            const list = files
                .map((file) => `<li><a href="${path.posix.join(reqUrl.pathname, file)}">${file}</a></li>`)
                .join('');
            return `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"></head><body><h1>Index of ${decodeURIComponent(reqUrl.pathname)}</h1><ul>${list}</ul></body></html>`;
        }
        catch (err) {
            return null;
        }
    }
    async handleRequest(req, res) {
        try {
            let requestPath = this.getRequestPath(req);
            if (!requestPath) {
                return this.sendErrorResponse(res, 403, '403 Forbidden');
            }
            let stats = await this.getPathStats(requestPath);
            if (stats?.isDirectory()) {
                const indexFilePath = path.join(requestPath, this.config.index);
                stats = await this.getPathStats(indexFilePath);
                if (!stats) {
                    const reqUrl = new URL(req.url || '', `http://${req.headers.host}`);
                    const directoryIndex = await this.generateDirectoryIndex(requestPath, reqUrl);
                    if (directoryIndex) {
                        res.writeHead(200, { 'Content-Type': 'text/html' }).end(directoryIndex);
                        return;
                    }
                    return this.sendErrorResponse(res, 403, '403 Forbidden');
                }
                requestPath = indexFilePath;
            }
            if (!stats) {
                return this.sendErrorResponse(res, 404, '404 Not Found');
            }
            const { headers, isCached } = await this.getResponseHeaders(req, requestPath, stats);
            if (isCached) {
                res.writeHead(304).end();
                return;
            }
            if (req.headers.range) {
                this.sendRangeResponse(req, res, requestPath, headers, stats);
            }
            else {
                this.sendFileResponse(req, res, requestPath, headers, stats);
            }
        }
        catch (err) {
            console.error(err);
            this.sendErrorResponse(res, 500, '500 Internal Server Error');
        }
    }
    start() {
        this.server.listen(this.config.port, () => {
            console.log(`Static server is running at http://localhost:${this.config.port}`);
        });
    }
}
