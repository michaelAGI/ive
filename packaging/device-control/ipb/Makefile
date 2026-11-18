# Defaults to the selected Xcode (honours DEVELOPER_DIR); override with XCODE_PATH=/path/to/Xcode.app
XCODE_PATH ?= $(patsubst %/Contents/Developer,%,$(shell xcode-select -p))
SDK_PRIVATE_FRAMEWORKS := $(XCODE_PATH)/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/System/Library/PrivateFrameworks

BUILD_DIR := build
SOURCES_DIR := Sources
TARGET := $(BUILD_DIR)/ipb-helper
VIDEO_TARGET := $(BUILD_DIR)/ipb-video
MIRROR_TARGET := $(BUILD_DIR)/ipb-mirror
MIRROR_PROBE_TARGET := $(BUILD_DIR)/ipb-mirror-probe
MIRROR_GLUE = $(filter-out $(BUILD_DIR)/ipb-helper.o,$(OBJS))

OBJS := \
	$(BUILD_DIR)/ipb-helper.o \
	$(BUILD_DIR)/mercury_glue.o \
	$(BUILD_DIR)/mercury_abi.o \
	$(BUILD_DIR)/universalhid_glue.o \
	$(BUILD_DIR)/universalhid_abi.o \
	$(BUILD_DIR)/uhid_request_abi.o

DEVICE_LDFLAGS = \
	-F/Library/Developer/PrivateFrameworks \
	-F/Library/Developer/PrivateFrameworks/CoreDevice.framework/Frameworks \
	-F/Library/Apple/System/Library/PrivateFrameworks \
	-F$(SDK_PRIVATE_FRAMEWORKS) \
	-framework Foundation -framework CoreFoundation \
	-framework CoreDevice -framework CoreDeviceUtilities \
	-framework RemoteXPC -framework Mercury -framework UniversalHID

PREFIX ?= /usr/local

.PHONY: all clean smoke install check-reports check-host

all: check-reports $(TARGET) $(VIDEO_TARGET) $(MIRROR_TARGET) $(MIRROR_PROBE_TARGET)

# Every hardcoded report allocation must cover its own HID descriptor. This is
# a build step, not a test, because the failure it catches is invisible at
# runtime: a short report is accepted, returns rc=0, and silently drops the
# fields that fell off the end.
check-reports:
	@python3 scripts/check_report_sizes.py

$(BUILD_DIR):
	mkdir -p $@

$(BUILD_DIR)/ipb-helper.o: $(SOURCES_DIR)/action_sender.m | $(BUILD_DIR)
	clang -fno-objc-arc -fblocks \
		-F/Library/Developer/PrivateFrameworks \
		-F$(SDK_PRIVATE_FRAMEWORKS) \
		-c $< -o $@

$(BUILD_DIR)/mercury_abi.o: $(SOURCES_DIR)/mercury_abi.S | $(BUILD_DIR)
	clang -c $< -o $@

$(BUILD_DIR)/universalhid_abi.o: $(SOURCES_DIR)/universalhid_abi.S | $(BUILD_DIR)
	clang -c $< -o $@

$(BUILD_DIR)/uhid_request_abi.o: $(SOURCES_DIR)/uhid_request_abi.S | $(BUILD_DIR)
	clang -c $< -o $@

$(BUILD_DIR)/mercury_glue.o: $(SOURCES_DIR)/mercury_glue.swift | $(BUILD_DIR)
	swiftc -parse-as-library -c $< -o $@

$(BUILD_DIR)/universalhid_glue.o: $(SOURCES_DIR)/universalhid_glue.swift | $(BUILD_DIR)
	swiftc -parse-as-library -c $< -o $@

$(TARGET): $(OBJS)
	swiftc $(OBJS) -o $@ $(DEVICE_LDFLAGS)


$(VIDEO_TARGET): $(SOURCES_DIR)/video_stream.m | $(BUILD_DIR)
	clang -fobjc-arc \
		-o $@ $< \
		-framework Foundation -framework CoreMedia -framework CoreVideo -lobjc \
		-Xlinker -undefined -Xlinker dynamic_lookup
	codesign -s - -f $@ >/dev/null 2>&1 || true   # in-process path needs no entitlement

# M1 evidence probe: reuse released Swift/assembly glue; no action_sender main.
$(BUILD_DIR)/mirror_probe.o: Experiments/mirror/mirror_probe.m | $(BUILD_DIR)
	clang -fobjc-arc -fblocks -Wall -Wextra -Wno-unused-parameter \
		-c $< -o $@

$(MIRROR_PROBE_TARGET): $(BUILD_DIR)/mirror_probe.o $(MIRROR_GLUE)
	swiftc $^ -o $@ $(DEVICE_LDFLAGS) \
		-framework CoreMedia -framework CoreVideo \
		-Xlinker -undefined -Xlinker dynamic_lookup
	codesign -s - -f $@

# Interactive mirror: existing oracle glue, with AppKit presentation.
$(BUILD_DIR)/mirror.o: $(SOURCES_DIR)/mirror.m $(SOURCES_DIR)/bounded_sender.h $(SOURCES_DIR)/display_geometry.h $(SOURCES_DIR)/device_control.h $(SOURCES_DIR)/keyboard_input.h | $(BUILD_DIR)
	clang -fobjc-arc -fblocks -Wall -Wextra -Wno-unused-parameter \
		-Wno-deprecated-declarations -c $< -o $@

$(MIRROR_TARGET): $(BUILD_DIR)/mirror.o $(MIRROR_GLUE)
	swiftc $^ -o $@ $(DEVICE_LDFLAGS) \
		-framework AppKit -framework AVFoundation -framework QuartzCore -framework CoreImage \
		-framework CoreMedia -framework CoreVideo \
		-Xlinker -undefined -Xlinker dynamic_lookup
	codesign -s - -f $@

$(BUILD_DIR)/test-input-reports: scripts/test_input_reports.swift $(SOURCES_DIR)/universalhid_glue.swift $(filter-out $(BUILD_DIR)/universalhid_glue.o,$(MIRROR_GLUE))
	swiftc -parse-as-library $^ -o $@ $(DEVICE_LDFLAGS)

$(BUILD_DIR)/test-mirror-keyboard.o: scripts/test_mirror_keyboard.m $(SOURCES_DIR)/mirror.m $(SOURCES_DIR)/keyboard_input.h $(SOURCES_DIR)/device_control.h $(SOURCES_DIR)/bounded_sender.h $(SOURCES_DIR)/display_geometry.h | $(BUILD_DIR)
	clang -fobjc-arc -fblocks -Wno-deprecated-declarations -c $< -o $@

$(BUILD_DIR)/test-mirror-keyboard: $(BUILD_DIR)/test-mirror-keyboard.o $(MIRROR_GLUE)
	swiftc $^ -o $@ $(DEVICE_LDFLAGS) \
		-framework AppKit -framework AVFoundation -framework QuartzCore -framework CoreImage \
		-framework CoreMedia -framework CoreVideo \
		-Xlinker -undefined -Xlinker dynamic_lookup

check-host: all $(BUILD_DIR)/test-input-reports $(BUILD_DIR)/test-mirror-keyboard
	sh scripts/check_host.sh

smoke: all
	bin/ipb screenshot $(BUILD_DIR)/smoke.png

install: all
	install -d $(PREFIX)/bin $(PREFIX)/libexec $(PREFIX)/share/ipb $(PREFIX)/share/zsh/site-functions
	install -m 755 bin/ipb $(PREFIX)/bin/ipb
	install -m 755 $(TARGET) $(PREFIX)/libexec/ipb-helper
	install -m 755 $(VIDEO_TARGET) $(PREFIX)/libexec/ipb-video
	codesign -s - -f $(PREFIX)/libexec/ipb-video >/dev/null 2>&1 || true
	install -m 755 $(MIRROR_TARGET) $(PREFIX)/libexec/ipb-mirror
	codesign -s - -f $(PREFIX)/libexec/ipb-mirror
	install -m 755 Sources/ipb_ax.py $(PREFIX)/libexec/ipb-ax.py
	install -m 755 Sources/ipb_support.py $(PREFIX)/libexec/ipb-support.py
	install -m 644 Sources/ax_archive.py $(PREFIX)/libexec/ax_archive.py
	install -m 644 Sources/ipb_mcp.py Sources/ipb_mcp_adapter.py Sources/ipb_mcp_process.py $(PREFIX)/libexec/
	install -m 644 requirements-ax.txt $(PREFIX)/share/ipb/requirements-ax.txt
	install -m 644 VERSION $(PREFIX)/share/ipb/VERSION
	install -m 755 scripts/smoke_matrix.sh $(PREFIX)/share/ipb/smoke_matrix.sh
	install -m 755 scripts/smoke_assertions.zsh $(PREFIX)/share/ipb/smoke_assertions.zsh
	install -m 755 scripts/png_pixels_digest.py $(PREFIX)/share/ipb/png_pixels_digest.py
	install -m 644 scripts/assert_search_text.swift $(PREFIX)/share/ipb/assert_search_text.swift
	install -m 644 completions/_ipb $(PREFIX)/share/zsh/site-functions/_ipb

clean:
	rm -rf $(BUILD_DIR)
