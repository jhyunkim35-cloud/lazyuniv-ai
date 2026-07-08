# 화자분리 워커 (로컬)

pyannote.ai 유료 API 대신 로컬 PC에서 도는 화자분리 워커. `api/whisper-stt.js`가
Firestore `diarizationJobs/{jobId}` 큐에 작업을 쌓으면, 이 워커가 폴링해서
가져가고 오픈소스 `pyannote/speaker-diarization-community-1` 모델로 화자를
분리해 turns를 다시 그 문서에 써준다. Groq Whisper 전사는 그대로 서버리스에서
동기 처리됨 — 이 워커는 화자 라벨만 담당.

## 실행

```powershell
worker\.venv\Scripts\python.exe worker\diarize_worker.py
```

인자 없이 그냥 무한 루프로 30초마다 폴링. 콘솔 로그로 작업당 다운로드/변환/
화자분리 소요시간과 RTF(실시간 대비 배속)가 한 줄씩 찍힘.

## 준비물

- `worker/serviceAccount.json` — Firebase 서비스 계정 키 (Firebase 콘솔 →
  프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성). `SERVICE_ACCOUNT_JSON`
  환경변수로 다른 경로 지정 가능.
- `HF_TOKEN` — Hugging Face 토큰 (pyannote 모델 접근용, 커뮤니티 라이선스
  동의 필요). 환경변수로 주거나, 없으면 `../.env.harness.local`의
  `HF_TOKEN=` 줄을 자동으로 읽음.
- ffmpeg — PATH에 있어야 함 (winget 설치 시 `%LOCALAPPDATA%\Microsoft\WinGet\Links`
  도 방어적으로 PATH에 추가해줌).

## 알려진 이슈 (고치지 말 것)

이 머신의 torchcodec Windows 빌드는 ffmpeg DLL이 없어서 pyannote 4.x의
기본 파일 경로 디코딩이 실패한다. 그래서 `pipeline(wav_path)` 대신 `wave`
모듈로 PCM을 직접 읽어 `{'waveform':..., 'sample_rate':16000}` 딕셔너리로
넘기는 우회를 씀 (`diarize_worker.py`의 `load_waveform`). 의도된 코드다 —
"파일 경로 넘기기"로 되돌리면 다시 깨진다.

## 자가 점검

```powershell
worker\.venv\Scripts\python.exe worker\diarize_worker.py selftest
```

turn 병합 로직(연속 동일화자 병합, 5000개 초과 시 gap 확장)만 assert로
검증하는 순수 로직 테스트. Firebase/모델 다운로드 없이 즉시 끝남.
