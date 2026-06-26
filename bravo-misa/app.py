"""
app.py – Giao diện chuyển đổi Bravo → MISA

Chạy:  python app.py
Yêu cầu:  pip install customtkinter openpyxl
"""

import queue
import sys
import threading
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox

import customtkinter as ctk

from converter import ConversionResult, convert

# ─────────────────────────────────────────────────────────────────────────────
ctk.set_appearance_mode("System")
ctk.set_default_color_theme("blue")

# Thư mục chứa app.py — dùng làm gốc cho các đường dẫn mặc định
_HERE = Path(__file__).parent

# Đường dẫn mặc định — thay tên file Bravo nếu cần
DEFAULT_INPUT  = _HERE / "Bravo_Template.xlsx"
DEFAULT_OUTPUT = _HERE / "output"
# ─────────────────────────────────────────────────────────────────────────────


class App(ctk.CTk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Bravo → MISA Converter")
        self.geometry("780x620")
        self.resizable(True, True)
        self.minsize(640, 500)

        # Trạng thái
        self._running    = False
        self._stop_flag  = False
        self._pause_evt  = threading.Event()
        self._pause_evt.set()          # mặc định không pause
        self._q: queue.Queue = queue.Queue()

        self._build_ui()
        self._poll()                   # bắt đầu vòng lặp nhận message từ worker

    # ─── Xây dựng giao diện ──────────────────────────────────────────────────

    def _build_ui(self) -> None:
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(5, weight=1)   # log box chiếm phần còn lại

        # ── File chọn ────────────────────────────────────────────────────────
        file_fr = ctk.CTkFrame(self)
        file_fr.grid(row=0, column=0, sticky="ew", padx=14, pady=(14, 4))
        file_fr.grid_columnconfigure(1, weight=1)

        ctk.CTkLabel(file_fr, text="File Bravo:").grid(
            row=0, column=0, padx=10, pady=8, sticky="w")
        self._in_var = ctk.StringVar(value=str(DEFAULT_INPUT))
        ctk.CTkEntry(file_fr, textvariable=self._in_var).grid(
            row=0, column=1, padx=5, sticky="ew")
        ctk.CTkButton(file_fr, text="Chọn…", width=80,
                      command=self._pick_file).grid(row=0, column=2, padx=10)

        ctk.CTkLabel(file_fr, text="Lưu vào:").grid(
            row=1, column=0, padx=10, pady=8, sticky="w")
        self._out_var = ctk.StringVar(value=str(DEFAULT_OUTPUT))
        ctk.CTkEntry(file_fr, textvariable=self._out_var).grid(
            row=1, column=1, padx=5, sticky="ew")
        ctk.CTkButton(file_fr, text="Chọn…", width=80,
                      command=self._pick_folder).grid(row=1, column=2, padx=10)

        # ── Options ───────────────────────────────────────────────────────────
        opt_fr = ctk.CTkFrame(self)
        opt_fr.grid(row=1, column=0, sticky="ew", padx=14, pady=4)

        self._debug_var = ctk.BooleanVar(value=False)
        ctk.CTkCheckBox(opt_fr,
                        text="Debug mode  (dừng sau mỗi 1 000 dòng, chờ bấm Tiếp tục)",
                        variable=self._debug_var).pack(side="left", padx=14, pady=8)

        # ── Buttons + trạng thái ──────────────────────────────────────────────
        btn_fr = ctk.CTkFrame(self)
        btn_fr.grid(row=2, column=0, sticky="ew", padx=14, pady=4)

        self._btn_convert = ctk.CTkButton(
            btn_fr, text="▶  Convert", width=130,
            font=ctk.CTkFont(size=13, weight="bold"),
            command=self._start)
        self._btn_convert.pack(side="left", padx=10, pady=8)

        self._btn_stop = ctk.CTkButton(
            btn_fr, text="⏹  Dừng", width=100,
            fg_color="#c0392b", hover_color="#922b21",
            state="disabled", command=self._stop)
        self._btn_stop.pack(side="left", padx=4)

        self._btn_continue = ctk.CTkButton(
            btn_fr, text="▶▶  Tiếp tục", width=120,
            fg_color="#27ae60", hover_color="#1e8449",
            state="disabled", command=self._resume)
        self._btn_continue.pack(side="left", padx=4)

        self._lbl_status = ctk.CTkLabel(btn_fr, text="Sẵn sàng",
                                        text_color="gray")
        self._lbl_status.pack(side="left", padx=20)

        # ── Progress ──────────────────────────────────────────────────────────
        prog_fr = ctk.CTkFrame(self)
        prog_fr.grid(row=3, column=0, sticky="ew", padx=14, pady=4)
        prog_fr.grid_columnconfigure(0, weight=1)

        self._progress = ctk.CTkProgressBar(prog_fr)
        self._progress.set(0)
        self._progress.grid(row=0, column=0, sticky="ew", padx=10, pady=(8, 2))

        self._lbl_count = ctk.CTkLabel(prog_fr, text="Dòng: 0 / 0",
                                       text_color="gray",
                                       font=ctk.CTkFont(size=12))
        self._lbl_count.grid(row=1, column=0, pady=(0, 8))

        # ── Log ───────────────────────────────────────────────────────────────
        log_hdr = ctk.CTkFrame(self, fg_color="transparent")
        log_hdr.grid(row=4, column=0, sticky="ew", padx=14)
        ctk.CTkLabel(log_hdr, text="Log").pack(side="left")
        ctk.CTkButton(log_hdr, text="Xóa", width=60, height=24,
                      command=self._clear_log).pack(side="right", padx=4)

        self._log_box = ctk.CTkTextbox(
            self, state="disabled",
            font=ctk.CTkFont(family="Consolas", size=11))
        self._log_box.grid(row=5, column=0, sticky="nsew", padx=14, pady=(2, 14))

    # ─── File dialog ─────────────────────────────────────────────────────────

    def _pick_file(self) -> None:
        path = filedialog.askopenfilename(
            title="Chọn file Excel Bravo",
            filetypes=[("Excel", "*.xlsx *.xls"), ("Tất cả", "*.*")])
        if path:
            self._in_var.set(path)

    def _pick_folder(self) -> None:
        path = filedialog.askdirectory(title="Chọn thư mục lưu kết quả")
        if path:
            self._out_var.set(path)

    # ─── Convert flow ────────────────────────────────────────────────────────

    def _start(self) -> None:
        in_file  = self._in_var.get().strip()
        out_dir  = self._out_var.get().strip()

        if not in_file:
            messagebox.showwarning("Thiếu thông tin", "Vui lòng chọn file Bravo.")
            return
        if not out_dir:
            messagebox.showwarning("Thiếu thông tin", "Vui lòng chọn thư mục lưu.")
            return

        self._running   = True
        self._stop_flag = False
        self._pause_evt.set()

        self._btn_convert.configure(state="disabled")
        self._btn_stop.configure(state="normal")
        self._btn_continue.configure(state="disabled")
        self._progress.set(0)
        self._lbl_status.configure(text="Đang xử lý…", text_color="#1a6fad")
        self._lbl_count.configure(text="Dòng: 0 / 0")

        self._log(f"{'─'*55}")
        self._log(f"Bắt đầu lúc {datetime.now().strftime('%H:%M:%S')}")
        self._log(f"Input : {in_file}")
        self._log(f"Output: {out_dir}")

        # Chạy conversion trong thread riêng để không block GUI
        threading.Thread(
            target=self._worker,
            args=(in_file, out_dir, self._debug_var.get()),
            daemon=True,
        ).start()

    def _worker(self, in_file: str, out_dir: str, debug: bool) -> None:
        """Chạy trên worker thread – không được gọi Tkinter trực tiếp."""
        try:
            result = convert(
                input_file=in_file,
                output_folder=out_dir,
                log_fn=lambda m: self._q.put(("log", m)),
                progress_fn=lambda d, t: self._q.put(("progress", d, t)),
                debug_mode=debug,
                pause_fn=self._pause_callback if debug else None,
                stop_check=lambda: self._stop_flag,
            )
            self._q.put(("done", result))
        except Exception:
            self._q.put(("error", __import__("traceback").format_exc()))

    def _pause_callback(self) -> None:
        """
        Được gọi từ worker thread sau mỗi batch khi debug mode.
        Block worker thread cho đến khi user bấm Tiếp tục.
        """
        self._q.put(("paused",))
        self._pause_evt.clear()
        self._pause_evt.wait()   # chờ GUI gọi _resume()

    def _stop(self) -> None:
        self._stop_flag = True
        self._pause_evt.set()   # mở khoá nếu đang pause
        self._lbl_status.configure(text="Đang dừng…", text_color="orange")

    def _resume(self) -> None:
        self._btn_continue.configure(state="disabled")
        self._lbl_status.configure(text="Đang xử lý…", text_color="#1a6fad")
        self._pause_evt.set()

    # ─── Queue polling (chạy trên main thread mỗi 50ms) ─────────────────────

    def _poll(self) -> None:
        try:
            while True:
                msg = self._q.get_nowait()
                self._handle(msg)
        except queue.Empty:
            pass
        finally:
            self.after(50, self._poll)

    def _handle(self, msg: tuple) -> None:
        kind = msg[0]

        if kind == "log":
            self._append_log(msg[1])

        elif kind == "progress":
            _, done, total = msg
            self._progress.set(done / total if total else 0)
            self._lbl_count.configure(text=f"Dòng: {done:,} / {total:,}")

        elif kind == "paused":
            self._lbl_status.configure(text="⏸  Debug – đang chờ…",
                                       text_color="orange")
            self._btn_continue.configure(state="normal")

        elif kind == "done":
            self._on_done(msg[1])

        elif kind == "error":
            self._on_error(msg[1])

    def _on_done(self, r: ConversionResult) -> None:
        self._running = False
        self._btn_convert.configure(state="normal")
        self._btn_stop.configure(state="disabled")
        self._btn_continue.configure(state="disabled")
        self._progress.set(1.0)
        self._lbl_status.configure(text="✅ Hoàn tất!", text_color="green")

        self._append_log(f"\n{'═'*55}")
        self._append_log(f"✅ HOÀN TẤT sau {r.elapsed_seconds:.1f}s")
        self._append_log(f"   Khách hàng : {r.customer_rows:>6,} dòng  →  {r.output_customer}")
        self._append_log(f"   Liên hệ    : {r.contact_rows:>6,} dòng  →  {r.output_contact}")
        self._append_log(f"   Lỗi        : {r.error_rows:>6,} dòng  →  {r.output_error}")

        messagebox.showinfo(
            "Hoàn tất",
            f"Chuyển đổi xong!\n\n"
            f"Khách hàng : {r.customer_rows:,}\n"
            f"Liên hệ    : {r.contact_rows:,}\n"
            f"Lỗi        : {r.error_rows:,}\n\n"
            f"Thư mục: {Path(r.output_customer).parent}",
        )

    def _on_error(self, tb: str) -> None:
        self._running = False
        self._btn_convert.configure(state="normal")
        self._btn_stop.configure(state="disabled")
        self._lbl_status.configure(text="❌ Lỗi!", text_color="red")
        self._append_log(f"❌ LỖI NGHIÊM TRỌNG:\n{tb}")
        messagebox.showerror("Lỗi không mong đợi", tb[:400])

    # ─── Log helpers ─────────────────────────────────────────────────────────

    def _log(self, msg: str) -> None:
        """Ghi log trực tiếp từ main thread."""
        self._append_log(msg)

    def _append_log(self, msg: str) -> None:
        self._log_box.configure(state="normal")
        self._log_box.insert("end", msg + "\n")
        self._log_box.see("end")
        self._log_box.configure(state="disabled")

    def _clear_log(self) -> None:
        self._log_box.configure(state="normal")
        self._log_box.delete("1.0", "end")
        self._log_box.configure(state="disabled")


# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    app = App()
    app.mainloop()
