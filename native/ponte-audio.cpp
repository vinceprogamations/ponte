// ponte-audio: captura o áudio de um aplicativo específico no Windows.
//
// Usa a captura por processo do WASAPI (Windows 10 2004 ou mais novo), a
// mesma ideia do "som do aplicativo" do Discord. Assim dá para transmitir o
// som do jogo sem levar junto a voz do Discord, evitando retorno.
//
// Uso:
//   ponte-audio windows                     lista janelas visíveis (JSON por linha)
//   ponte-audio capture <pid> include       só o áudio do processo <pid> e filhos
//   ponte-audio capture <pid> exclude       tudo, menos o processo <pid> e filhos
//
// Na captura, escreve PCM 16 bits, 48 kHz, estéreo na saída padrão até ela
// ser fechada.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <dwmapi.h>
#include <io.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string>

#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "dwmapi.lib")

// ------------------------------------------------------------ listar janelas

static std::string utf8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}

static std::string jsonEscape(const std::string& s) {
  std::string o;
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) { char b[8]; sprintf_s(b, "\\u%04x", c); o += b; }
        else o += (char)c;
    }
  }
  return o;
}

static BOOL CALLBACK onWindow(HWND hwnd, LPARAM) {
  if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER)) return TRUE;
  if (GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) return TRUE;
  BOOL cloaked = FALSE;
  DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
  if (cloaked) return TRUE;
  int len = GetWindowTextLengthW(hwnd);
  if (len <= 0) return TRUE;
  std::wstring title(len + 1, L'\0');
  GetWindowTextW(hwnd, title.data(), len + 1);
  title.resize(wcslen(title.c_str()));

  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  std::wstring exe;
  if (HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)) {
    wchar_t path[MAX_PATH * 2];
    DWORD size = MAX_PATH * 2;
    if (QueryFullProcessImageNameW(p, 0, path, &size)) {
      exe = path;
      size_t slash = exe.find_last_of(L"\\/");
      if (slash != std::wstring::npos) exe = exe.substr(slash + 1);
    }
    CloseHandle(p);
  }
  printf("{\"hwnd\":%llu,\"pid\":%lu,\"exe\":\"%s\",\"title\":\"%s\"}\n",
         (unsigned long long)(ULONG_PTR)hwnd, pid,
         jsonEscape(utf8(exe)).c_str(), jsonEscape(utf8(title)).c_str());
  return TRUE;
}

// ------------------------------------------------------------ captura

class ActivationHandler : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
  LONG refs = 1;

 public:
  HANDLE done = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  IAudioClient* client = nullptr;

  STDMETHODIMP QueryInterface(REFIID riid, void** out) override {
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    } else if (riid == __uuidof(IAgileObject)) {
      *out = static_cast<IAgileObject*>(this);
    } else {
      *out = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs); }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG r = InterlockedDecrement(&refs);
    if (!r) delete this;
    return r;
  }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT activated = E_FAIL;
    IUnknown* unknown = nullptr;
    HRESULT hr = op->GetActivateResult(&activated, &unknown);
    if (SUCCEEDED(hr) && SUCCEEDED(activated) && unknown) {
      result = unknown->QueryInterface(IID_PPV_ARGS(&client));
    } else {
      result = FAILED(hr) ? hr : activated;
    }
    if (unknown) unknown->Release();
    SetEvent(done);
    return S_OK;
  }
};

static int fail(const char* step, HRESULT hr) {
  fprintf(stderr, "ponte-audio: %s falhou (0x%08lx)\n", step, (unsigned long)hr);
  return 2;
}

static int capture(DWORD pid, bool include) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return fail("CoInitializeEx", hr);

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      include ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT prop = {};
  prop.vt = VT_BLOB;
  prop.blob.cbSize = sizeof(params);
  prop.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  auto* handler = new ActivationHandler();
  IActivateAudioInterfaceAsyncOperation* op = nullptr;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &prop, handler, &op);
  if (FAILED(hr)) return fail("ActivateAudioInterfaceAsync", hr);
  WaitForSingleObject(handler->done, INFINITE);
  if (op) op->Release();
  if (FAILED(handler->result) || !handler->client) return fail("ativação da captura", handler->result);
  IAudioClient* client = handler->client;

  WAVEFORMATEX format = {};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 2;
  format.nSamplesPerSec = 48000;
  format.wBitsPerSample = 16;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                          200000, 0, &format, nullptr);
  if (FAILED(hr)) return fail("IAudioClient::Initialize", hr);

  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  client->SetEventHandle(ready);
  IAudioCaptureClient* cap = nullptr;
  hr = client->GetService(IID_PPV_ARGS(&cap));
  if (FAILED(hr)) return fail("GetService", hr);
  hr = client->Start();
  if (FAILED(hr)) return fail("Start", hr);

  _setmode(_fileno(stdout), _O_BINARY);
  std::string silence;
  for (;;) {
    WaitForSingleObject(ready, 100);
    UINT32 packet = 0;
    while (SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      size_t bytes = (size_t)frames * format.nBlockAlign;
      const void* out = data;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        if (silence.size() < bytes) silence.assign(bytes, '\0');
        out = silence.data();
      }
      bool ok = fwrite(out, 1, bytes, stdout) == bytes;
      cap->ReleaseBuffer(frames);
      if (!ok) return 0;  // a Ponte fechou o canal: encerra
    }
    if (fflush(stdout) != 0) return 0;
  }
}

int main(int argc, char** argv) {
  if (argc >= 2 && strcmp(argv[1], "windows") == 0) {
    EnumWindows(onWindow, 0);
    return 0;
  }
  if (argc >= 4 && strcmp(argv[1], "capture") == 0) {
    DWORD pid = strtoul(argv[2], nullptr, 10);
    bool include = strcmp(argv[3], "exclude") != 0;
    return capture(pid, include);
  }
  fprintf(stderr, "uso: ponte-audio windows | ponte-audio capture <pid> include|exclude\n");
  return 1;
}
