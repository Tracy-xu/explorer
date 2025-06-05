# Explorer

Explorer 一个支持 GZip 压缩、缓存、Range 分块、文件目录索引的静态资源服务器，文件管理器。

## Installation

```bash
npm install @telei/explorer -g
# or
npx -p @telei/explorer explore
```

## Execution

```bash
explore
explore -p 8888 -r public
```

## Help

```
PS D:\> explore -h
Usage: explore [options]

Options:
  -p, --port   server port (default: 3000)
  -r, --root   root directory to serve (default: current working directory)
  -h, --help   display help for command
```
