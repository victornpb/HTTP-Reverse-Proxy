#!/bin/bash
cd "$( dirname "$0" )"

# Keep the process running if it crashes
while true; do
  echo "Updating proxy..."
  npm install -g https://github.com/victornpb/reproxy.git

  echo "Starting proxy..."
  reverseproxy start
  
  echo "Reverse Proxy stopped. Restarting in 5 seconds..."
  sleep 5
done
