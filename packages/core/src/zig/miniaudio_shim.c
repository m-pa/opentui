#define MINIAUDIO_IMPLEMENTATION

#if defined(__linux__)
#define MA_ENABLE_ALSA
#define MA_NO_PULSEAUDIO
#define MA_NO_JACK
#define MA_NO_OSS
#define MA_NO_AAUDIO
#define MA_NO_OPENSL
#define MA_NO_COREAUDIO
#define MA_NO_WASAPI
#define MA_NO_DSOUND
#define MA_NO_WINMM
#endif

#if defined(__APPLE__)
#define MA_ENABLE_COREAUDIO
#define MA_NO_PULSEAUDIO
#define MA_NO_ALSA
#define MA_NO_JACK
#define MA_NO_OSS
#define MA_NO_WASAPI
#define MA_NO_DSOUND
#define MA_NO_WINMM
#endif

#if defined(_WIN32)
#define MA_ENABLE_WASAPI
#define MA_NO_DSOUND
#define MA_NO_WINMM
#define MA_NO_PULSEAUDIO
#define MA_NO_ALSA
#define MA_NO_JACK
#define MA_NO_OSS
#define MA_NO_COREAUDIO
#endif

#include "vendor/miniaudio/miniaudio.h"
