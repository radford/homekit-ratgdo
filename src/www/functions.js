/***********************************************************************
 * homekit-ratgdo web page javascript functions
 *
 * Copyright (c) 2023-24 David Kerr, https://github.com/dkerr64
 *
 */

// Global vars...
var semaphoreNumber = 0;  // for Semaphore code, to support multiple semaphores.
var fetchSemaphore = undefined; // Semaphore to control HTTP fetch.
var serverStatus = {};    // object into which all server status is held.
var statusUpdater = 0;    // to identify the setInterval timer used to update status

// convert miliseconds to dd:hh:mm:ss used to calculate server uptime
function msToTime(duration) {
    var milliseconds = Math.floor((duration % 1000) / 100),
        seconds = Math.floor((duration / 1000) % 60),
        minutes = Math.floor((duration / (1000 * 60)) % 60),
        hours = Math.floor((duration / (1000 * 60 * 60)) % 24),
        days = Math.floor((duration / (1000 * 60 * 60 * 24)));

    hours = (hours < 10) ? "0" + hours : hours;
    minutes = (minutes < 10) ? "0" + minutes : minutes;
    seconds = (seconds < 10) ? "0" + seconds : seconds;

    return days + ":" + hours + ":" + minutes + ":" + seconds;
}

// checkStatus is called once on page load to retrieve status from the server...
// and setInterval a timer that will refresh the data every 10 seconds
async function checkStatus() {
    if (!fetchSemaphore) fetchSemaphore = new Semaphore();
    const releaseSemaphore = await fetchSemaphore.acquire();
    try {
        const response = await fetch("./status.json");
        if (response.status !== 200) {
            console.warn("Error retrieving status from RATGDO");
            return;
        }
        serverStatus = await response.json();
        console.log(serverStatus);
        // Add letter 'v' to front of returned firmware version.
        // Hack because firmware uses v0.0.0 and 0.0.0 for different purposes.
        serverStatus.firmwareVersion = "v" + serverStatus.firmwareVersion;

        document.getElementById("devicename").innerHTML = serverStatus.deviceName;
        if (serverStatus.paired) {
            document.getElementById("unpair").value = "Un-pair HomeKit";
            document.getElementById("qrcode").style.display = "none";
            document.getElementById("re-pair-info").style.display = "inline-block";
        } else {
            document.getElementById("unpair").value = "Pair to HomeKit";
            document.getElementById("re-pair-info").style.display = "none";
            document.getElementById("qrcode").style.display = "inline-block";
        }
        document.getElementById("uptime").innerHTML = msToTime(serverStatus.upTime);
        document.getElementById("firmware").innerHTML = serverStatus.firmwareVersion;
        document.getElementById("firmware2").innerHTML = serverStatus.firmwareVersion;
        document.getElementById("ssid").innerHTML = serverStatus.wifiSSID;
        document.getElementById("macaddress").innerHTML = serverStatus.macAddress;
        document.getElementById("ipaddress").innerHTML = serverStatus.localIP;
        document.getElementById("netmask").innerHTML = serverStatus.subnetMask;
        document.getElementById("gateway").innerHTML = serverStatus.gatewayIP;
        document.getElementById("accessoryid").innerHTML = serverStatus.accessoryID;

        document.getElementById("doorstate").innerHTML = serverStatus.garageDoorState;
        document.getElementById("lockstate").innerHTML = serverStatus.garageLockState;
        document.getElementById("lighton").innerHTML = serverStatus.garageLightOn;
        document.getElementById("obstruction").innerHTML = serverStatus.garageObstructed;
        document.getElementById("motion").innerHTML = serverStatus.garageMotion;

        // Refresh the data every 10 seconds.
        statusUpdater = setInterval(async () => {
            if (!fetchSemaphore) fetchSemaphore = new Semaphore();
            const releaseSemaphore = await fetchSemaphore.acquire();
            try {
                const response = await fetch("./status.json?uptime&doorstate&lockstate&lighton&obstruction&motion");
                if (response.status !== 200) {
                    console.warn("Error retrieving status from RATGDO");
                    return;
                }
                serverStatus = { ...serverStatus, ...await response.json() };
                document.getElementById("uptime").innerHTML = msToTime(serverStatus.upTime);
                document.getElementById("doorstate").innerHTML = serverStatus.garageDoorState;
                document.getElementById("lockstate").innerHTML = serverStatus.garageLockState;
                document.getElementById("lighton").innerHTML = serverStatus.garageLightOn;
                document.getElementById("obstruction").innerHTML = serverStatus.garageObstructed;
                document.getElementById("motion").innerHTML = serverStatus.garageMotion;
            }
            finally {
                releaseSemaphore();
            }
        }, 10000);
    }
    finally {
        releaseSemaphore();
    }
    return;
};

// Displays a series of dot-dot-dots into an element's innerHTML to give
// user some reassurance of activity.  Used during firmware update.
function dotDotDot(elem) {
    var i = 0;
    var dots = ".";
    return setInterval(() => {
        if (i++ % 20) {
            dots = dots + ".";
        } else {
            dots = ".";
        }
        elem.innerHTML = dots;
    }, 500);
}

async function checkVersion(progress) {
    const versionElem = document.getElementById("newversion");
    const versionElem2 = document.getElementById("newversion2");
    versionElem.innerHTML = "Checking";
    versionElem2.innerHTML = "Checking";
    const spanDots = document.getElementById(progress);
    const aniDots = dotDotDot(spanDots);
    const response = await fetch("https://api.github.com/repos/ratgdo/homekit-ratgdo/releases", {
        method: "GET",
        cache: "no-cache",
        redirect: "follow"
    });
    const releases = await response.json();
    if (response.status !== 200) {
        // We have probably hit the GitHub API rate limits (60 per hour for non-authenticated)
        versionElem.innerHTML = "";
        versionElem2.innerHTML = "";
        console.warn("Error retrieving status from GitHub" + releases.message);
        return;
    }
    // make sure we have newest release first
    const latest = releases.sort((a, b) => {
        return Date.parse(b.created_at) - Date.parse(a.created_at);
    })[0];
    serverStatus.latestVersion = latest;
    console.log("Newest version: " + latest.tag_name);
    const asset = latest.assets.find((obj) => {
        return (obj.content_type === "application/octet-stream") && (obj.name.startsWith("homekit-ratgdo"));
    });
    serverStatus.downloadURL = "https://ratgdo.github.io/homekit-ratgdo/firmware/" + asset.name;
    let msg = "You have newest release";
    if (serverStatus.firmwareVersion !== latest.tag_name) {
        // Newest version at GitHub is different from that installed
        msg = "Update available  (" + latest.tag_name + ")";
    }
    clearInterval(aniDots);
    spanDots.innerHTML = "";
    versionElem.innerHTML = msg;
    versionElem2.innerHTML = latest.tag_name;
}

// repurposes the myModal <div> to display a countdown timer
// from 30 seconds to zero, at end of which the page is reloaded.
// Used at end of firmware update or on reboot request.
function countdown30(msg) {
    const spanDots = document.getElementById("dotdot3");
    document.getElementById("modalTitle").innerHTML = "";
    document.getElementById("updateMsg").innerHTML = "RATGDO device rebooting...&nbsp;";
    document.getElementById("updateDialog").style.display = "none";
    document.getElementById("modalClose").style.display = 'none';
    document.getElementById("myModal").style.display = 'block';
    document.getElementById("updateDotDot").style.display = "block";
    spanDots.innerHTML = "";
    var seconds = 30;
    spanDots.innerHTML = seconds;
    var countdown = setInterval(() => {
        if (seconds-- === 0) {
            clearInterval(countdown);
            clearInterval(statusUpdater);
            location.reload();
            return;
        } else {
            spanDots.innerHTML = seconds;
        }
    }, 1000);

}

// Handles request to update server firmware from either GitHub (default) or from
// a user provided file.
async function firmwareUpdate(github = true) {
    var showRebootMsg = false;
    const spanDots = document.getElementById("dotdot3");
    const spanMsg = document.getElementById("updateMsg");
    const aniDots = dotDotDot(spanDots);
    try {
        document.getElementById("updateDialog").style.display = "none";
        document.getElementById("updateDotDot").style.display = "block";
        if (!fetchSemaphore) fetchSemaphore = new Semaphore();
        const releaseSemaphore = await fetchSemaphore.acquire();
        try {
            if (github) {
                if (!serverStatus.latestVersion) {
                    console.log("Cannot download firmware, latest version unknown");
                    alert("Firmware version at GitHub is unknown, cannot update directly from GitHub.");
                    return;
                }
                console.log("Download firmware from: " + serverStatus.downloadURL);
                let response = await fetch(serverStatus.downloadURL, {
                    method: "GET",
                    cache: "no-cache",
                    redirect: "follow",
                    headers: {
                        "Accept": "application/octet-stream",
                    },
                });
                const blob = await response.blob();
                console.log("Download complete, size: " + blob.size);
                const formData = new FormData();
                formData.append("content", blob);
                response = await fetch("./update", {
                    method: "POST",
                    body: formData,
                });
            } else {
                const inputElem = document.querySelector('input[type="file"]');
                const formData = new FormData();
                if (inputElem.files.length > 0) {
                    console.log("Uploading file: " + inputElem.files[0]);
                    formData.append("file", inputElem.files[0]);
                    response = await fetch("./update", {
                        method: "POST",
                        body: formData,
                    });
                } else {
                    console.log("No file name provided");
                    alert("You must select a file to upload.");
                    return;
                }
            }
            showRebootMsg = true;
            console.log("Upload complete");
        }
        finally {
            releaseSemaphore();
        }
    }
    finally {
        clearInterval(aniDots);
        if (showRebootMsg) {
            countdown30("Update complete, RATGDO device rebooting...&nbsp;");
        } else {
            document.getElementById("updateDotDot").style.display = "none";
            document.getElementById("updateDialog").style.display = "block";
        }
    }
}

async function rebootRATGDO() {
    var response = await fetch("./reboot", {
        method: "POST",
    });
    if (response.status !== 200) {
        console.warn("Error attempting to reboot RATGDO");
        return;
    }
    countdown30("RATGDO device rebooting...&nbsp;");
}

async function setGDO(arg, value) {
    console.log("SetGDO request semaphore");
    if (!fetchSemaphore) fetchSemaphore = new Semaphore();
    const releaseSemaphore = await fetchSemaphore.acquire();
    console.log("SetGDO acquired semaphore");
    try {
        const formData = new FormData();
        formData.append(arg, value);
        console.log("SetGDO await fetch");
        var response = await fetch("/setgdo", {
            method: "POST",
            body: formData,
            signal: AbortSignal.timeout(2000),
        });
        console.log("SetGDO fetch response: " + response.status);
        if (response.status !== 200) {
            console.warn("Error setting RATGDO state");
            return;
        }
        switch (arg) {
            case "lighton":
                document.getElementById("lighton").innerHTML = (value == "1") ? "true" : "false";
                break;
            case "lockstate":
                document.getElementById("lockstate").innerHTML = (value == "1") ? "Secured" : "Unsecured";
                break;
            case "doorstate":
                document.getElementById("lockstate").innerHTML = (value == "1") ? "Opening" : "Closing";
                break;
            default:
                break;
        }
    }
    catch (err) {
        if (err.name === "TimeoutError") {
            console.error("Timeout: It took more than 5 seconds to get the result!");
        } else if (err.name === "AbortError") {
            console.error("Fetch aborted by user action (browser stop button, closing tab, etc.");
        } else if (err.name === "TypeError") {
            console.error("AbortSignal.timeout() method is not supported");
        } else {
            // A network error, or some other problem.
            console.error(`Error: type: ${err.name}, message: ${err.message}`);
        }
    }
    finally {
        console.log("SetGDO releasing semaphore");
        releaseSemaphore();
    }
}

async function changePassword() {
    if (newPW.value === "") {
        alert("New password cannot be blank");
        return;
    }
    if (newPW.value !== confirmPW.value) {
        alert("Passwords do not match");
        return;
    }
    const www_username = "admin";
    const www_realm = "RATGDO Login Required";
    passwordHash = MD5(www_username + ":" + www_realm + ":" + newPW.value);
    console.log("Set new credentials to: " + passwordHash);
    await setGDO("credentials", passwordHash);
    clearInterval(statusUpdater);
    // On success, go to home page.
    // User will have to re-authenticate to get back to settings.
    location.href = "/";
    return;
}

// MD5 Hash function from
// https://stackoverflow.com/questions/14733374/how-to-generate-an-md5-hash-from-a-string-in-javascript-node-js
// We use this to obfuscate a new password/credentials when sent to server so that
// it is not obvious in the network transmission
var MD5 = function (d) { var r = M(V(Y(X(d), 8 * d.length))); return r.toLowerCase(); }; function M(d) { for (var _, m = "0123456789ABCDEF", f = "", r = 0; r < d.length; r++)_ = d.charCodeAt(r), f += m.charAt(_ >>> 4 & 15) + m.charAt(15 & _); return f; } function X(d) { for (var _ = Array(d.length >> 2), m = 0; m < _.length; m++)_[m] = 0; for (m = 0; m < 8 * d.length; m += 8)_[m >> 5] |= (255 & d.charCodeAt(m / 8)) << m % 32; return _; } function V(d) { for (var _ = "", m = 0; m < 32 * d.length; m += 8)_ += String.fromCharCode(d[m >> 5] >>> m % 32 & 255); return _; } function Y(d, _) { d[_ >> 5] |= 128 << _ % 32, d[14 + (_ + 64 >>> 9 << 4)] = _; for (var m = 1732584193, f = -271733879, r = -1732584194, i = 271733878, n = 0; n < d.length; n += 16) { var h = m, t = f, g = r, e = i; f = md5_ii(f = md5_ii(f = md5_ii(f = md5_ii(f = md5_hh(f = md5_hh(f = md5_hh(f = md5_hh(f = md5_gg(f = md5_gg(f = md5_gg(f = md5_gg(f = md5_ff(f = md5_ff(f = md5_ff(f = md5_ff(f, r = md5_ff(r, i = md5_ff(i, m = md5_ff(m, f, r, i, d[n + 0], 7, -680876936), f, r, d[n + 1], 12, -389564586), m, f, d[n + 2], 17, 606105819), i, m, d[n + 3], 22, -1044525330), r = md5_ff(r, i = md5_ff(i, m = md5_ff(m, f, r, i, d[n + 4], 7, -176418897), f, r, d[n + 5], 12, 1200080426), m, f, d[n + 6], 17, -1473231341), i, m, d[n + 7], 22, -45705983), r = md5_ff(r, i = md5_ff(i, m = md5_ff(m, f, r, i, d[n + 8], 7, 1770035416), f, r, d[n + 9], 12, -1958414417), m, f, d[n + 10], 17, -42063), i, m, d[n + 11], 22, -1990404162), r = md5_ff(r, i = md5_ff(i, m = md5_ff(m, f, r, i, d[n + 12], 7, 1804603682), f, r, d[n + 13], 12, -40341101), m, f, d[n + 14], 17, -1502002290), i, m, d[n + 15], 22, 1236535329), r = md5_gg(r, i = md5_gg(i, m = md5_gg(m, f, r, i, d[n + 1], 5, -165796510), f, r, d[n + 6], 9, -1069501632), m, f, d[n + 11], 14, 643717713), i, m, d[n + 0], 20, -373897302), r = md5_gg(r, i = md5_gg(i, m = md5_gg(m, f, r, i, d[n + 5], 5, -701558691), f, r, d[n + 10], 9, 38016083), m, f, d[n + 15], 14, -660478335), i, m, d[n + 4], 20, -405537848), r = md5_gg(r, i = md5_gg(i, m = md5_gg(m, f, r, i, d[n + 9], 5, 568446438), f, r, d[n + 14], 9, -1019803690), m, f, d[n + 3], 14, -187363961), i, m, d[n + 8], 20, 1163531501), r = md5_gg(r, i = md5_gg(i, m = md5_gg(m, f, r, i, d[n + 13], 5, -1444681467), f, r, d[n + 2], 9, -51403784), m, f, d[n + 7], 14, 1735328473), i, m, d[n + 12], 20, -1926607734), r = md5_hh(r, i = md5_hh(i, m = md5_hh(m, f, r, i, d[n + 5], 4, -378558), f, r, d[n + 8], 11, -2022574463), m, f, d[n + 11], 16, 1839030562), i, m, d[n + 14], 23, -35309556), r = md5_hh(r, i = md5_hh(i, m = md5_hh(m, f, r, i, d[n + 1], 4, -1530992060), f, r, d[n + 4], 11, 1272893353), m, f, d[n + 7], 16, -155497632), i, m, d[n + 10], 23, -1094730640), r = md5_hh(r, i = md5_hh(i, m = md5_hh(m, f, r, i, d[n + 13], 4, 681279174), f, r, d[n + 0], 11, -358537222), m, f, d[n + 3], 16, -722521979), i, m, d[n + 6], 23, 76029189), r = md5_hh(r, i = md5_hh(i, m = md5_hh(m, f, r, i, d[n + 9], 4, -640364487), f, r, d[n + 12], 11, -421815835), m, f, d[n + 15], 16, 530742520), i, m, d[n + 2], 23, -995338651), r = md5_ii(r, i = md5_ii(i, m = md5_ii(m, f, r, i, d[n + 0], 6, -198630844), f, r, d[n + 7], 10, 1126891415), m, f, d[n + 14], 15, -1416354905), i, m, d[n + 5], 21, -57434055), r = md5_ii(r, i = md5_ii(i, m = md5_ii(m, f, r, i, d[n + 12], 6, 1700485571), f, r, d[n + 3], 10, -1894986606), m, f, d[n + 10], 15, -1051523), i, m, d[n + 1], 21, -2054922799), r = md5_ii(r, i = md5_ii(i, m = md5_ii(m, f, r, i, d[n + 8], 6, 1873313359), f, r, d[n + 15], 10, -30611744), m, f, d[n + 6], 15, -1560198380), i, m, d[n + 13], 21, 1309151649), r = md5_ii(r, i = md5_ii(i, m = md5_ii(m, f, r, i, d[n + 4], 6, -145523070), f, r, d[n + 11], 10, -1120210379), m, f, d[n + 2], 15, 718787259), i, m, d[n + 9], 21, -343485551), m = safe_add(m, h), f = safe_add(f, t), r = safe_add(r, g), i = safe_add(i, e); } return Array(m, f, r, i); } function md5_cmn(d, _, m, f, r, i) { return safe_add(bit_rol(safe_add(safe_add(_, d), safe_add(f, i)), r), m); } function md5_ff(d, _, m, f, r, i, n) { return md5_cmn(_ & m | ~_ & f, d, _, r, i, n); } function md5_gg(d, _, m, f, r, i, n) { return md5_cmn(_ & f | m & ~f, d, _, r, i, n); } function md5_hh(d, _, m, f, r, i, n) { return md5_cmn(_ ^ m ^ f, d, _, r, i, n); } function md5_ii(d, _, m, f, r, i, n) { return md5_cmn(m ^ (_ | ~f), d, _, r, i, n); } function safe_add(d, _) { var m = (65535 & d) + (65535 & _); return (d >> 16) + (_ >> 16) + (m >> 16) << 16 | 65535 & m; } function bit_rol(d, _) { return d << _ | d >>> 32 - _; }

// Semaphore code is inspired by
// https://github.com/Granjow/semaphore-promise
// We use semaphores to serialize access/requests to the server with Javascript fetch API.
// Why bother?  Well an abundance of caution... fetch is acyncronous and we have a interval
// timer running to keep the web page up-to-date on server state.  It could yield while waiting
// for response from server, during which time another fetch request could be sent to the server.
// The ESP8266WebServer code is primitive, and so being super cautious here and trying to prevent
// overlaping requests to the server.
// But... this MAY be overkill and unnecessary...
class Semaphore {
    name;
    _loggedName;
    _maxSemaphores;
    _nextSemaphoreId = 0;
    _currentSemaphores;
    _waitingCallers;

    /**
     * Creates a new semaphore container.
     * @param count Number of available semaphores (default: 1)
     * @param opts Additional options for the semaphore
     */
    constructor(count = 1) {
        this._maxSemaphores = count;
        this.name = `anonymous ${semaphoreNumber++}`;
        this._loggedName = `“${this.name}”`;
        this._currentSemaphores = new Set();
        this._waitingCallers = [];
    }

    tryAcquire() {
        const semaphoreId = this.nextSemaphoreId();
        ////console.debug(`Trying acquire for semaphore ${this._loggedName} #${semaphoreId} …`);
        if (this.hasAvailableSemaphores) {
            ////console.debug(`tryAcquire() successful for semaphore ${this._loggedName} #${semaphoreId}`);
            this._currentSemaphores.add(semaphoreId);
            return this.createReleaseFunction(semaphoreId);
        } else {
            throw new Error('No semaphore available.');
        }
    }

    /**
     * Acquire a new semaphore.
     * The returned promise resolves as soon as a semaphore is available and returns a function `release`
     * which has to be used to release the acquired promise.
     * @return {Promise<Function>}
     */
    acquire() {
        const semaphoreId = this.nextSemaphoreId();
        //console.debug(`Starting acquire for semaphore ${this._loggedName} #${semaphoreId} …`);

        const addCallerToWaitlist = (resolve) => {
            const release = this.createReleaseFunction(semaphoreId);

            this._waitingCallers.push(() => {
                //console.debug(`acquire() successful for semaphore ${this._loggedName} #${semaphoreId}`);
                resolve(release);
                return semaphoreId;
            });
        };
        const treatPendingCallersNow = () => this.treatPendingCallers();

        const promise = new Promise(addCallerToWaitlist);
        setTimeout(treatPendingCallersNow, 0);

        return promise;
    }

    /**
     * Release the given semaphore.
     * This is usually done from inside the resolve callback because the ID is only known there.
     */
    release(id) {
        //console.debug(`Releasing semaphore ${this._loggedName} #${id}`);
        if (this._currentSemaphores.has(id)) {
            this._currentSemaphores.delete(id);
        }
        const treatPendingCallersAfterRelease = () => this.treatPendingCallers();
        setTimeout(treatPendingCallersAfterRelease, 0);
    }

    nextSemaphoreId() {
        return this._nextSemaphoreId++;
    }

    get hasAvailableSemaphores() {
        return this._currentSemaphores.size < this._maxSemaphores;
    }

    /**
     * @param id ID of the semaphore which is released when calling this function
     */
    createReleaseFunction(id) {
        const releaseMySemaphore = () => this.release(id);
        return releaseMySemaphore;
    }

    /**
     * When a semaphore is requested, the request is added to a queue.
     * The queue is processed by this function.
     */
    treatPendingCallers() {
        //console.debug(`Checking for free semaphore ${this._loggedName}: ${this._waitingCallers.length} waiting`);
        while (this._waitingCallers.length > 0 && this.hasAvailableSemaphores) {
            const caller = this._waitingCallers.shift();
            if (caller !== undefined) {
                //console.debug(`Free semaphore ${this._loggedName} found, assigning.`);
                const semaphoreId = caller();
                this._currentSemaphores.add(semaphoreId);
            }
        }
    }
}