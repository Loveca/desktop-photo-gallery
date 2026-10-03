"""静照的本地静态服务。

和 `python -m http.server` 唯一的区别：所有响应都带 no-store。
不然浏览器会按 Last-Modified 做启发式缓存，改完代码刷新半天不生效。
用法：python server.py [端口]
"""

import http.server
import socketserver
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 安静一点，控制台只留服务地址


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    with Server(("127.0.0.1", port), NoCacheHandler) as httpd:
        print(f"http://127.0.0.1:{port}/index.html")
        print("Ctrl+C 停止")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()
