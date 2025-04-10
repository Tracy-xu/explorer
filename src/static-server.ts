import http from 'http';
import type { Server, IncomingMessage, ServerResponse } from 'http';
import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import mime from 'mime';
import crypto from 'crypto';
import zlib from 'zlib';

interface StaticServerConfig {
  port?: number;
  root?: string;
  index?: string;
}

interface Range {
  start: number;
  end: number;
}

interface ResponseHeaderResult {
  headers: Record<string, string>;
  isCached: boolean;
}

export default class StaticServer {
  private config: Required<StaticServerConfig>;
  private server: Server;

  constructor(config?: StaticServerConfig) {
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

  private async getPathStats(requestPath: string): Promise<fs.Stats | null> {
    try {
      return await fsp.stat(requestPath);
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  private getRequestPath(req: IncomingMessage): string | null {
    if (!req.url || !req.headers.host) return null;

    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    let requestPath = path.join(this.config.root, decodeURIComponent(reqUrl.pathname));
    requestPath = path.normalize(requestPath);

    return requestPath.startsWith(this.config.root) ? requestPath : null;
  }

  private async getETag(filePath: string, stats: fs.Stats): Promise<string> {
    if (stats.size < 1024 * 1024) {
      const content = await fsp.readFile(filePath);
      return crypto.createHash('md5').update(content).digest('hex');
    }
    return crypto
      .createHash('md5')
      .update(`${stats.size}-${stats.mtime.getTime()}`)
      .digest('hex');
  }

  private parseRange(range: string, size: number): Range | null {
    const parts = range.replace(/bytes=/, '').split('-');
    let start = parseInt(parts[0], 10);
    let end = parseInt(parts[1], 10);

    if (isNaN(start)) {
      start = size - end;
      end = size - 1;
    } else if (isNaN(end)) {
      end = size - 1;
    }

    return start >= size || end >= size ? null : { start, end };
  }

  private shouldCompress(req: IncomingMessage, filePath: string): boolean {
    const acceptEncoding = req.headers['accept-encoding'];
    if (!acceptEncoding?.includes('gzip')) return false;

    const compressibleExtensions = [
      '.html',
      '.htm',
      '.css',
      '.js',
      '.json',
      '.xml',
      '.txt',
      '.svg',
      '.webmanifest'
    ];

    const ext = path.extname(filePath).toLowerCase();
    return compressibleExtensions.includes(ext);
  }

  private sendErrorResponse(res: ServerResponse, statusCode: number, message: string): void {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
    res.end(message);
  }

  private async getResponseHeaders(
    req: IncomingMessage,
    filePath: string,
    stats: fs.Stats
  ): Promise<ResponseHeaderResult> {
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = mime.getType(filePath) || 'application/octet-stream';
    const etag = await this.getETag(filePath, stats);
    const lastModified = stats.mtime.toUTCString();

    const isCached = req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === lastModified;

    const headers: Record<string, string> = {
      'Content-Type': mimeType,
      'ETag': etag,
      'Last-Modified': lastModified,
      'Cache-Control': ext === '.html' ? 'no-cache, must-revalidate' : 'public, max-age=31536000, immutable',
      'Accept-Ranges': 'bytes'
    };

    return { headers, isCached };
  }

  private compressStream(stream: fs.ReadStream): zlib.Gzip {
    const gzip = zlib.createGzip();
    return stream.pipe(gzip);
  }

  private sendRangeResponse(
    req: IncomingMessage,
    res: ServerResponse,
    filePath: string,
    headers: Record<string, string>,
    stats: fs.Stats
  ): void {
    const rangeVal = this.parseRange(req.headers.range!, stats.size);
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
    } else {
      fileStream.pipe(res);
    }
  }

  private sendFileResponse(
    req: IncomingMessage,
    res: ServerResponse,
    filePath: string,
    headers: Record<string, string>,
    stats: fs.Stats
  ): void {
    const fileStream = fs.createReadStream(filePath);
    if (this.shouldCompress(req, filePath)) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      this.compressStream(fileStream).pipe(res);
    } else {
      headers['Content-Length'] = String(stats.size);
      res.writeHead(200, headers);
      fileStream.pipe(res);
    }
  }

  async generateDirectoryIndex(directoryPath: string, reqUrl: URL) {
    try {
      const files = await fsp.readdir(directoryPath);
      const list = files.map(file => `<li><a href="${path.posix.join(reqUrl.pathname, file)}">${file}</a></li>`).join('');
      return `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"></head><body><h1>Index of ${decodeURIComponent(reqUrl.pathname)}</h1><ul>${list}</ul></body></html>`;
    } catch (err) {
      return null;
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
        requestPath = indexFilePath
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
      } else {
        this.sendFileResponse(req, res, requestPath, headers, stats);
      }
    } catch (err) {
      console.error(err);
      this.sendErrorResponse(res, 500, '500 Internal Server Error');
    }
  }

  public start(): void {
    this.server.listen(this.config.port, () => {
      console.log(`Static server is running at http://localhost:${this.config.port}`);
    });
  }
}
