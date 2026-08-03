ID BME280 WEBSITE V7 - GITHUB PAGES
===================================

FILES TO UPLOAD TO THE REPOSITORY ROOT
--------------------------------------
Upload these files directly into the top level of the GitHub repository:

- index.html
- style.css
- script.js

Do not place them inside another folder.

GITHUB PAGES SETTING
--------------------
In the repository open:

Settings -> Pages

Set:

Source: Deploy from a branch
Branch: main
Folder: / (root)

The webpage will normally be:

https://YOUR-GITHUB-USERNAME.github.io/YOUR-REPOSITORY-NAME/

HIVEMQ LOGIN
------------
The username field starts with:

bme280

Enter the current HiveMQ password in the webpage and press Connect.
The password is not included in these public website files.

The webpage connects with secure WebSockets using:

wss://e1fe53e3c20b4f3daf38aafa8e16ff4b.s1.eu.hivemq.cloud:8884/mqtt

MQTT PERMISSIONS NEEDED
-----------------------
The webpage login needs permission to:

Publish:
- illsley/bme280/history/request

Subscribe:
- illsley/bme280/telemetry
- illsley/bme280/status
- illsley/bme280/history/data
- illsley/bme280/history/complete

Using permission for illsley/bme280/# in both directions is the simplest setup
for this learning project.

HOW THE HISTORY WORKS
---------------------
The ESP32 firmware stores one averaged record per minute in a circular RAM
buffer. It keeps up to 2,880 records, which is 48 hours.

When the webpage connects, it requests the stored records through MQTT. The
ESP32 sends them in small chunks and the webpage rebuilds the three graphs.

The history is held only in ESP32 RAM. Resetting the ESP32, removing power, or
uploading firmware clears the history.
