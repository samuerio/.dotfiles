#!/bin/bash
# toggle_tapping.sh

#xinput list
DEVICE="ELAN962C:00 04F3:30D0 Touchpad"
CURRENT=$(xinput list-props "$DEVICE" | grep "libinput Tapping Enabled" | awk 'NR==1 {print $NF}')

if [ "$CURRENT" = "0" ]; then
    xinput set-prop "$DEVICE" "libinput Tapping Enabled" 1
    echo "Tapping enabled"
else
    xinput set-prop "$DEVICE" "libinput Tapping Enabled" 0
    echo "Tapping disabled"
fi
