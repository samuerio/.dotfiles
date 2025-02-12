#!/bin/sh

# Change below to suit your system
BACKLIGHT="/sys/class/backlight/intel_backlight"
BRIGHTNESS="$BACKLIGHT/brightness"
MAX_BRIGHTNESS=$(cat "$BACKLIGHT/max_brightness")

inotifywait -m -e modify "$BRIGHTNESS" \
  | while IFS= read -r line; do cat $BRIGHTNESS; done \
  | xob -m "$MAX_BRIGHTNESS"
