/* =========================================================
   FILEVAULT V1
   Local file storage with:
   - IndexedDB
   - Cookies for unlocked keys
   - Folder structure
   - Upload / Download
   - Protected files
========================================================= */


/* =========================================================
   DATABASE
========================================================= */

const DB_NAME = "FileVaultDB";
const DB_VERSION = 1;

const FILE_STORE = "files";
const FOLDER_STORE = "folders";

let db;

let currentFolderId = null;
let currentFolder = null;

let selectedFile = null;
let fileWaitingForKey = null;


/* =========================================================
   INITIALIZE DATABASE
========================================================= */

function openDatabase() {
    return new Promise((resolve, reject) => {

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = function (event) {

            const database = event.target.result;

            if (!database.objectStoreNames.contains(FILE_STORE)) {

                const fileStore = database.createObjectStore(
                    FILE_STORE,
                    { keyPath: "id" }
                );

                fileStore.createIndex(
                    "folderId",
                    "folderId",
                    { unique: false }
                );
            }

            if (!database.objectStoreNames.contains(FOLDER_STORE)) {

                const folderStore = database.createObjectStore(
                    FOLDER_STORE,
                    { keyPath: "id" }
                );

                folderStore.createIndex(
                    "parentId",
                    "parentId",
                    { unique: false }
                );
            }
        };

        request.onsuccess = function () {
            db = request.result;
            resolve(db);
        };

        request.onerror = function () {
            reject(request.error);
        };
    });
}


/* =========================================================
   DATABASE HELPERS
========================================================= */

function generateId() {
    return crypto.randomUUID();
}


function addRecord(storeName, data) {

    return new Promise((resolve, reject) => {

        const transaction = db.transaction(
            storeName,
            "readwrite"
        );

        const store = transaction.objectStore(storeName);

        const request = store.add(data);

        request.onsuccess = () => resolve(data);

        request.onerror = () => reject(request.error);
    });
}


function getRecord(storeName, id) {

    return new Promise((resolve, reject) => {

        const transaction = db.transaction(
            storeName,
            "readonly"
        );

        const store = transaction.objectStore(storeName);

        const request = store.get(id);

        request.onsuccess = () => resolve(request.result);

        request.onerror = () => reject(request.error);
    });
}


function getAllRecords(storeName) {

    return new Promise((resolve, reject) => {

        const transaction = db.transaction(
            storeName,
            "readonly"
        );

        const store = transaction.objectStore(storeName);

        const request = store.getAll();

        request.onsuccess = () => resolve(request.result);

        request.onerror = () => reject(request.error);
    });
}


function deleteRecord(storeName, id) {

    return new Promise((resolve, reject) => {

        const transaction = db.transaction(
            storeName,
            "readwrite"
        );

        const store = transaction.objectStore(storeName);

        const request = store.delete(id);

        request.onsuccess = () => resolve();

        request.onerror = () => reject(request.error);
    });
}


/* =========================================================
   COOKIES
========================================================= */

function setCookie(name, value, days = 365) {

    const expires = new Date(
        Date.now() + days * 86400000
    ).toUTCString();

    document.cookie =
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}


function getCookie(name) {

    const cookies = document.cookie.split("; ");

    const target = encodeURIComponent(name);

    for (const cookie of cookies) {

        const [key, ...value] = cookie.split("=");

        if (key === target) {
            return decodeURIComponent(value.join("="));
        }
    }

    return null;
}


/* =========================================================
   KEY HASHING
========================================================= */

async function hashKey(key) {

    const encoder = new TextEncoder();

    const data = encoder.encode(key);

    const hashBuffer = await crypto.subtle.digest(
        "SHA-256",
        data
    );

    const hashArray = Array.from(
        new Uint8Array(hashBuffer)
    );

    return hashArray
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}


/*
    Each unlocked key receives its own cookie.

    Example:

    fv_key_abc123 = 1
    fv_key_8ef921 = 1
*/

function isKeySaved(hash) {

    return getCookie(`fv_key_${hash}`) === "1";
}


function saveKey(hash) {

    setCookie(`fv_key_${hash}`, "1", 365);
}


/* =========================================================
   FOLDERS
========================================================= */

async function createFolder(name, parentId = null) {

    const folders = await getAllRecords(FOLDER_STORE);

    const alreadyExists = folders.some(folder =>
        folder.parentId === parentId &&
        folder.name.toLowerCase() === name.toLowerCase()
    );

    if (alreadyExists) {
        throw new Error("Dieser Ordner existiert bereits.");
    }

    const folder = {

        id: generateId(),

        name: name.trim(),

        parentId: parentId,

        createdAt: Date.now()
    };

    await addRecord(FOLDER_STORE, folder);

    return folder;
}


async function getFolderPath(folderId) {

    const folders = await getAllRecords(FOLDER_STORE);

    const path = [];

    let id = folderId;

    while (id) {

        const folder = folders.find(
            item => item.id === id
        );

        if (!folder) break;

        path.unshift(folder);

        id = folder.parentId;
    }

    return path;
}


async function getSubFolders(parentId) {

    const folders = await getAllRecords(FOLDER_STORE);

    return folders.filter(
        folder => folder.parentId === parentId
    );
}


async function deleteFolderRecursive(folderId) {

    const folders = await getAllRecords(FOLDER_STORE);

    const children = folders.filter(
        folder => folder.parentId === folderId
    );

    for (const child of children) {
        await deleteFolderRecursive(child.id);
    }

    const files = await getAllRecords(FILE_STORE);

    const folderFiles = files.filter(
        file => file.folderId === folderId
    );

    for (const file of folderFiles) {
        await deleteRecord(FILE_STORE, file.id);
    }

    await deleteRecord(FOLDER_STORE, folderId);
}


/* =========================================================
   FILES
========================================================= */

async function saveFile(file, folderId, key) {

    const keyHash = await hashKey(key);

    const record = {

        id: generateId(),

        name: file.name,

        size: file.size,

        type: file.type || "application/octet-stream",

        folderId: folderId,

        keyHash: keyHash,

        blob: file,

        createdAt: Date.now()
    };

    await addRecord(FILE_STORE, record);

    /*
        The user who uploads the file automatically
        gets access because the key is stored as a cookie.
    */

    saveKey(keyHash);

    return record;
}


/* =========================================================
   FILE ICON
========================================================= */

function getFileIcon(file) {

    if (file.type.startsWith("image/")) {
        return "🖼️";
    }

    if (file.type.startsWith("video/")) {
        return "🎬";
    }

    if (file.type.startsWith("audio/")) {
        return "🎵";
    }

    if (file.type.includes("pdf")) {
        return "📕";
    }

    if (
        file.type.includes("zip") ||
        file.type.includes("rar") ||
        file.name.endsWith(".7z")
    ) {
        return "📦";
    }

    if (
        file.type.includes("word") ||
        file.name.endsWith(".docx")
    ) {
        return "📘";
    }

    if (
        file.type.includes("excel") ||
        file.name.endsWith(".xlsx")
    ) {
        return "📗";
    }

    if (
        file.type.includes("javascript") ||
        file.name.endsWith(".js")
    ) {
        return "💻";
    }

    if (
        file.type.includes("text") ||
        file.name.endsWith(".txt")
    ) {
        return "📄";
    }

    return "📄";
}


/* =========================================================
   FORMAT SIZE
========================================================= */

function formatSize(bytes) {

    if (bytes === 0) {
        return "0 B";
    }

    const units = [
        "B",
        "KB",
        "MB",
        "GB",
        "TB"
    ];

    const index = Math.floor(
        Math.log(bytes) / Math.log(1024)
    );

    const value =
        bytes / Math.pow(1024, index);

    return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}


/* =========================================================
   RENDER
========================================================= */

async function render() {

    const folders = await getAllRecords(FOLDER_STORE);
    const files = await getAllRecords(FILE_STORE);

    const currentFolders = folders.filter(
        folder => folder.parentId === currentFolderId
    );

    const currentFiles = files.filter(
        file => file.folderId === currentFolderId
    );

    const list = document.getElementById("fileList");
    const empty = document.getElementById("emptyState");

    list.innerHTML = "";

    /*
        Sort:
        1. folders
        2. files
    */

    currentFolders.sort((a, b) =>
        a.name.localeCompare(b.name)
    );

    currentFiles.sort((a, b) =>
        a.name.localeCompare(b.name)
    );


    /* FOLDERS */

    for (const folder of currentFolders) {

        const element = document.createElement("div");

        element.className = "file-item";

        element.innerHTML = `
            <div class="file-icon">📁</div>

            <div class="file-info">
                <span class="file-name">
                    ${escapeHTML(folder.name)}
                </span>

                <div class="file-meta">
                    <span>Ordner</span>
                </div>
            </div>

            <div class="file-actions">

                <button
                    class="icon-btn"
                    title="Öffnen"
                    data-action="open-folder"
                    data-id="${folder.id}">
                    →
                </button>

                <button
                    class="icon-btn danger delete-button"
                    title="Löschen"
                    data-action="delete-folder"
                    data-id="${folder.id}">
                    🗑
                </button>

            </div>
        `;

        list.appendChild(element);
    }


    /* FILES */

    for (const file of currentFiles) {

        const unlocked = isKeySaved(file.keyHash);

        const element = document.createElement("div");

        element.className =
            unlocked
                ? "file-item"
                : "file-item locked";


        if (unlocked) {

            element.innerHTML = `
                <div class="file-icon">
                    ${getFileIcon(file)}
                </div>

                <div class="file-info">
                    <span class="file-name">
                        ${escapeHTML(file.name)}
                    </span>

                    <div class="file-meta">
                        <span>${formatSize(file.size)}</span>
                        <span>•</span>
                        <span>${formatDate(file.createdAt)}</span>
                    </div>
                </div>

                <div class="file-actions">

                    <button
                        class="icon-btn"
                        title="Herunterladen"
                        data-action="download"
                        data-id="${file.id}">
                        ⬇
                    </button>

                    <button
                        class="icon-btn danger delete-button"
                        title="Löschen"
                        data-action="delete-file"
                        data-id="${file.id}">
                        🗑
                    </button>

                </div>
            `;

        } else {

            element.innerHTML = `
                <div class="file-icon">
                    🔒
                </div>

                <div class="file-info">
                    <span class="file-name">
                        Geschützte Datei
                    </span>

                    <div class="file-meta">
                        <span class="lock-badge">
                            🔑 Key erforderlich
                        </span>
                    </div>
                </div>

                <div class="file-actions">

                    <button
                        class="icon-btn"
                        title="Freischalten"
                        data-action="unlock"
                        data-id="${file.id}">
                        🔑
                    </button>

                </div>
            `;
        }

        list.appendChild(element);
    }


    const totalItems =
        currentFolders.length +
        currentFiles.length;

    document.getElementById("itemCount").textContent =
        `${totalItems} ${totalItems === 1 ? "Element" : "Elemente"}`;


    empty.classList.toggle(
        "hidden",
        totalItems !== 0
    );


    renderBreadcrumb();

    updateStorageSize(files);
}


/* =========================================================
   BREADCRUMB
========================================================= */

async function renderBreadcrumb() {

    const breadcrumb =
        document.getElementById("breadcrumb");

    breadcrumb.innerHTML = "";

    const path = await getFolderPath(currentFolderId);


    if (path.length === 0) {

        const current = document.createElement("span");

        current.className = "breadcrumb-current";

        current.textContent = "Meine Dateien";

        breadcrumb.appendChild(current);

        document.getElementById(
            "currentFolderTitle"
        ).textContent = "Meine Dateien";

        return;
    }


    path.forEach((folder, index) => {

        const item = document.createElement("span");

        item.className =
            index === path.length - 1
                ? "breadcrumb-current"
                : "breadcrumb-item";

        item.textContent = folder.name;


        if (index !== path.length - 1) {

            item.addEventListener(
                "click",
                () => {
                    currentFolderId = folder.id;
                    render();
                }
            );
        }


        breadcrumb.appendChild(item);


        if (index < path.length - 1) {

            const separator =
                document.createElement("span");

            separator.className =
                "breadcrumb-separator";

            separator.textContent = "/";

            breadcrumb.appendChild(separator);
        }
    });


    document.getElementById(
        "currentFolderTitle"
    ).textContent =
        path[path.length - 1].name;
}


/* =========================================================
   STORAGE SIZE
========================================================= */

function updateStorageSize(files) {

    const total = files.reduce(
        (sum, file) => sum + file.size,
        0
    );

    document.getElementById(
        "storageUsed"
    ).textContent = formatSize(total);
}


/* =========================================================
   OPEN FOLDER
========================================================= */

async function openFolder(id) {

    currentFolderId = id;

    render();
}


/* =========================================================
   DOWNLOAD
========================================================= */

async function downloadFile(id) {

    const file = await getRecord(
        FILE_STORE,
        id
    );

    if (!file) {
        showToast("Datei wurde nicht gefunden.");
        return;
    }

    if (!isKeySaved(file.keyHash)) {

        openKeyModal(file);

        return;
    }

    const url =
        URL.createObjectURL(file.blob);

    const link =
        document.createElement("a");

    link.href = url;

    link.download = file.name;

    document.body.appendChild(link);

    link.click();

    link.remove();

    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 1000);
}


/* =========================================================
   KEY MODAL
========================================================= */

function openKeyModal(file) {

    fileWaitingForKey = file;

    document.getElementById(
        "lockedFileName"
    ).textContent =
        file.name;

    document.getElementById(
        "accessKey"
    ).value = "";

    document.getElementById(
        "keyError"
    ).classList.add("hidden");

    openModal("keyModal");

    setTimeout(() => {

        document.getElementById(
            "accessKey"
        ).focus();

    }, 100);
}


/* =========================================================
   ESCAPE HTML
========================================================= */

function escapeHTML(value) {

    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


/* =========================================================
   DATE
========================================================= */

function formatDate(timestamp) {

    return new Date(timestamp).toLocaleDateString(
        "de-DE",
        {
            day: "2-digit",
            month: "2-digit",
            year: "numeric"
        }
    );
}


/* =========================================================
   MODALS
========================================================= */

function openModal(id) {

    document
        .getElementById(id)
        .classList.remove("hidden");
}


function closeModal(id) {

    document
        .getElementById(id)
        .classList.add("hidden");
}


/* =========================================================
   TOAST
========================================================= */

let toastTimeout;

function showToast(message) {

    const toast =
        document.getElementById("toast");

    toast.textContent = message;

    toast.classList.add("show");

    clearTimeout(toastTimeout);

    toastTimeout = setTimeout(() => {

        toast.classList.remove("show");

    }, 3000);
}


/* =========================================================
   UPLOAD FOLDER SELECT
========================================================= */

async function updateFolderSelect() {

    const folders =
        await getAllRecords(FOLDER_STORE);

    const select =
        document.getElementById("uploadFolder");

    select.innerHTML = "";

    const rootOption =
        document.createElement("option");

    rootOption.value = "";

    rootOption.textContent =
        "📁 Meine Dateien";

    select.appendChild(rootOption);


    /*
        Show folders with indentation
    */

    const buildOptions =
        (parentId, depth) => {

            const children =
                folders
                    .filter(folder =>
                        folder.parentId === parentId
                    )
                    .sort((a, b) =>
                        a.name.localeCompare(b.name)
                    );

            children.forEach(folder => {

                const option =
                    document.createElement("option");

                option.value = folder.id;

                option.textContent =
                    `${"— ".repeat(depth)}📁 ${folder.name}`;

                select.appendChild(option);

                buildOptions(
                    folder.id,
                    depth + 1
                );
            });
        };


    buildOptions(null, 0);


    select.value =
        currentFolderId || "";
}


/* =========================================================
   EVENT LISTENERS
========================================================= */

document.addEventListener(
    "DOMContentLoaded",
    async () => {

        await openDatabase();

        await render();

        await updateFolderSelect();
    }
);


/* =========================
   UPLOAD BUTTON
========================= */

document.getElementById(
    "uploadButton"
).addEventListener(
    "click",
    async () => {

        await updateFolderSelect();

        openModal("uploadModal");
    }
);


document.getElementById(
    "emptyUploadButton"
).addEventListener(
    "click",
    async () => {

        await updateFolderSelect();

        openModal("uploadModal");
    }
);


/* =========================
   NEW FOLDER
========================= */

document.getElementById(
    "newFolderButton"
).addEventListener(
    "click",
    () => {

        document.getElementById(
            "folderName"
        ).value = "";

        openModal("folderModal");

        setTimeout(() => {

            document.getElementById(
                "folderName"
            ).focus();

        }, 100);
    }
);


/* =========================
   ROOT
========================= */

document.getElementById(
    "rootButton"
).addEventListener(
    "click",
    () => {

        currentFolderId = null;

        render();
    }
);


/* =========================
   FILE INPUT
========================= */

document.getElementById(
    "fileInput"
).addEventListener(
    "change",
    event => {

        const file =
            event.target.files[0];

        if (!file) return;

        selectFile(file);
    }
);


function selectFile(file) {

    selectedFile = file;

    document.getElementById(
        "selectedFile"
    ).classList.remove("hidden");

    document.getElementById(
        "selectedFileName"
    ).textContent =
        file.name;

    document.getElementById(
        "selectedFileSize"
    ).textContent =
        formatSize(file.size);

    document.getElementById(
        "selectedFileText"
    ).textContent =
        "Datei ausgewählt";
}


/* =========================================================
   DRAG & DROP
========================================================= */

const dropZone =
    document.getElementById("dropZone");


dropZone.addEventListener(
    "dragover",
    event => {

        event.preventDefault();

        dropZone.classList.add("dragover");
    }
);


dropZone.addEventListener(
    "dragleave",
    () => {

        dropZone.classList.remove("dragover");
    }
);


dropZone.addEventListener(
    "drop",
    event => {

        event.preventDefault();

        dropZone.classList.remove("dragover");

        const file =
            event.dataTransfer.files[0];

        if (file) {
            selectFile(file);
        }
    }
);


/* =========================================================
   UPLOAD
========================================================= */

document.getElementById(
    "uploadForm"
).addEventListener(
    "submit",
    async event => {

        event.preventDefault();

        if (!selectedFile) {

            showToast(
                "Bitte zuerst eine Datei auswählen."
            );

            return;
        }


        const key =
            document.getElementById(
                "uploadKey"
            ).value.trim();


        if (!key) {

            showToast(
                "Bitte einen Key eingeben."
            );

            return;
        }


        const folder =
            document.getElementById(
                "uploadFolder"
            ).value || null;


        try {

            await saveFile(
                selectedFile,
                folder,
                key
            );


            closeModal("uploadModal");

            selectedFile = null;

            document.getElementById(
                "uploadForm"
            ).reset();

            document.getElementById(
                "selectedFile"
            ).classList.add("hidden");


            await render();

            showToast(
                "Datei erfolgreich gespeichert."
            );

        } catch (error) {

            console.error(error);

            showToast(
                "Beim Speichern ist ein Fehler aufgetreten."
            );
        }
    }
);


/* =========================================================
   CREATE FOLDER
========================================================= */

document.getElementById(
    "folderForm"
).addEventListener(
    "submit",
    async event => {

        event.preventDefault();

        const name =
            document.getElementById(
                "folderName"
            ).value.trim();


        if (!name) return;


        try {

            await createFolder(
                name,
                currentFolderId
            );

            closeModal("folderModal");

            await render();

            await updateFolderSelect();

            showToast(
                "Ordner erstellt."
            );

        } catch (error) {

            showToast(
                error.message
            );
        }
    }
);


/* =========================================================
   KEY VERIFICATION
========================================================= */

document.getElementById(
    "keyForm"
).addEventListener(
    "submit",
    async event => {

        event.preventDefault();

        if (!fileWaitingForKey) {
            return;
        }


        const key =
            document.getElementById(
                "accessKey"
            ).value;


        const hash =
            await hashKey(key);


        if (
            hash !==
            fileWaitingForKey.keyHash
        ) {

            document.getElementById(
                "keyError"
            ).classList.remove("hidden");

            return;
        }


        /*
            Correct key:
            Save it permanently as cookie.
        */

        saveKey(hash);


        const file =
            fileWaitingForKey;

        fileWaitingForKey = null;

        closeModal("keyModal");

        await render();

        showToast(
            "Datei freigeschaltet."
        );


        /*
            Automatically download after
            successful key verification.
        */

        setTimeout(() => {

            downloadFile(file.id);

        }, 200);
    }
);


/* =========================================================
   FILE LIST ACTIONS
========================================================= */

document.getElementById(
    "fileList"
).addEventListener(
    "click",
    async event => {

        const button =
            event.target.closest(
                "[data-action]"
            );


        if (!button) return;


        const action =
            button.dataset.action;

        const id =
            button.dataset.id;


        /* OPEN FOLDER */

        if (action === "open-folder") {

            await openFolder(id);

            return;
        }


        /* DOWNLOAD */

        if (action === "download") {

            await downloadFile(id);

            return;
        }


        /* UNLOCK */

        if (action === "unlock") {

            const file =
                await getRecord(
                    FILE_STORE,
                    id
                );

            if (file) {
                openKeyModal(file);
            }

            return;
        }


        /* DELETE FILE */

        if (action === "delete-file") {

            const confirmed =
                confirm(
                    "Diese Datei wirklich löschen?"
                );

            if (!confirmed) return;


            await deleteRecord(
                FILE_STORE,
                id
            );

            await render();

            showToast(
                "Datei gelöscht."
            );

            return;
        }


        /* DELETE FOLDER */

        if (action === "delete-folder") {

            const confirmed =
                confirm(
                    "Ordner und alle darin enthaltenen Dateien löschen?"
                );

            if (!confirmed) return;


            await deleteFolderRecursive(id);

            await render();

            await updateFolderSelect();

            showToast(
                "Ordner gelöscht."
            );

            return;
        }
    }
);


/* =========================================================
   CLOSE BUTTONS
========================================================= */

document
    .querySelectorAll("[data-close]")
    .forEach(button => {

        button.addEventListener(
            "click",
            () => {

                closeModal(
                    button.dataset.close
                );
            }
        );
    });


/* =========================================================
   CLICK OUTSIDE MODAL
========================================================= */

document
    .querySelectorAll(".modal")
    .forEach(modal => {

        modal.addEventListener(
            "click",
            event => {

                if (event.target === modal) {

                    modal.classList.add(
                        "hidden"
                    );
                }
            }
        );
    });


/* =========================================================
   ESCAPE KEY
========================================================= */

document.addEventListener(
    "keydown",
    event => {

        if (event.key !== "Escape") {
            return;
        }

        document
            .querySelectorAll(".modal")
            .forEach(modal => {

                modal.classList.add(
                    "hidden"
                );
            });
    }
);


/* =========================================================
   KEY BUTTON
========================================================= */

document.getElementById(
    "keyButton"
).addEventListener(
    "click",
    () => {

        showToast(
            "Gespeicherte Keys werden automatisch verwendet."
        );
    }
);