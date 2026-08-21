const KALORI_GITHUB_CONFIG = {
    repo: 'sifirdandeneme1/kalori-hesaplama',
    branch: 'main',
    path: 'besinler.json'
};

const KALORI_SYNC_QUEUE_KEY = 'kh_food_sync_queue_v1';
const KALORI_LAST_SYNC_KEY = 'kh_food_last_sync_v1';

let kaloriSyncRunning = false;
let kaloriSyncAgain = false;

function getKaloriToken() {
    if (
        !EMBEDDED_KALORI_TOKEN ||
        EMBEDDED_KALORI_TOKEN.startsWith('__')
    ) {
        return '';
    }

    return EMBEDDED_KALORI_TOKEN;
}

function kaloriGithubHeaders() {
    return {
        'Authorization': 'Bearer ' + getKaloriToken(),
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Cache-Control': 'no-cache, no-store',
        'Pragma': 'no-cache'
    };
}

function kaloriGithubApiUrl() {
    return (
        'https://api.github.com/repos/' +
        KALORI_GITHUB_CONFIG.repo +
        '/contents/' +
        KALORI_GITHUB_CONFIG.path
    );
}

function encodeKaloriBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';

    for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(
            ...bytes.subarray(i, i + 8192)
        );
    }

    return btoa(binary);
}

function decodeKaloriBase64(value) {
    const cleanValue = value.replace(/\n/g, '');
    const binary = atob(cleanValue);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return new TextDecoder().decode(bytes);
}

function kaloriFoodIdFromName(name) {
    const normalized = String(name)
        .toLocaleLowerCase('tr')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ı/g, 'i')
        .replace(/ş/g, 's')
        .replace(/ğ/g, 'g')
        .replace(/ü/g, 'u')
        .replace(/ö/g, 'o')
        .replace(/ç/g, 'c')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

    return 'gh_' + (normalized || Date.now());
}

function kaloriLocalFoodFromRemote(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const name = String(item.name || '').trim();

    if (!name) {
        return null;
    }

    let type = item.type;

    if (!type) {
        const remoteUnit = String(
            item.unit || ''
        ).toLocaleLowerCase('tr');

        if (
            remoteUnit === 'gram' ||
            remoteUnit === 'g'
        ) {
            type = 'g';
        } else if (
            remoteUnit === 'mililitre' ||
            remoteUnit === 'ml'
        ) {
            type = 'ml';
        } else if (
            remoteUnit === 'adet' ||
            remoteUnit === 'paket' ||
            remoteUnit === 'piece'
        ) {
            type = 'piece';
        }
    }

    if (!['g', 'ml', 'piece'].includes(type)) {
        return null;
    }

    const calories = Number(
        item.calories ?? item.cal
    );

    if (!Number.isFinite(calories) || calories <= 0) {
        return null;
    }

    const defaultBase =
        type === 'piece' ? 1 : 100;

    const baseAmount = Number(
        item.baseAmount ?? defaultBase
    );

    if (
        !Number.isFinite(baseAmount) ||
        baseAmount <= 0
    ) {
        return null;
    }

    let normalizedCalories;

    if (type === 'piece') {
        normalizedCalories =
            calories / baseAmount;
    } else {
        normalizedCalories =
            calories * 100 / baseAmount;
    }

    return {
        id: String(
            item.id || kaloriFoodIdFromName(name)
        ),
        name: name,
        type: type,
        cal: Number(
            normalizedCalories.toFixed(4)
        )
    };
}

function kaloriRemoteFoodFromLocal(food) {
    const unit =
        food.type === 'g'
            ? 'gram'
            : food.type === 'ml'
                ? 'mililitre'
                : 'adet';

    return {
        id: food.id,
        name: food.name,
        unit: unit,
        baseAmount:
            food.type === 'piece' ? 1 : 100,
        calories: Number(food.cal)
    };
}

function kaloriParseRemoteFoods(text) {
    const parsed = JSON.parse(text);

    const list = Array.isArray(parsed)
        ? parsed
        : parsed.foods;

    if (!Array.isArray(list)) {
        throw new Error(
            'besinler.json dosya biçimi geçersiz.'
        );
    }

    const result = [];
    const usedIds = new Set();

    for (const item of list) {
        const food =
            kaloriLocalFoodFromRemote(item);

        if (!food || usedIds.has(food.id)) {
            continue;
        }

        usedIds.add(food.id);
        result.push(food);
    }

    if (result.length === 0) {
        throw new Error(
            'GitHub dosyasında geçerli besin bulunamadı.'
        );
    }

    return result;
}

function kaloriCreateRemoteDocument(list) {
    return {
        version: 1,
        updatedAt: new Date().toISOString(),
        foods: list.map(
            kaloriRemoteFoodFromLocal
        )
    };
}

function kaloriLoadQueue() {
    try {
        const parsed = JSON.parse(
            localStorage.getItem(
                KALORI_SYNC_QUEUE_KEY
            ) || '[]'
        );

        return Array.isArray(parsed)
            ? parsed
            : [];
    } catch (_) {
        return [];
    }
}

function kaloriSaveQueue(queue) {
    localStorage.setItem(
        KALORI_SYNC_QUEUE_KEY,
        JSON.stringify(queue)
    );
}

function kaloriQueueAction(action) {
    const queue = kaloriLoadQueue()
        .filter(
            item => item.id !== action.id
        );

    queue.push(action);
    kaloriSaveQueue(queue);
}

function kaloriClearProcessedActions(processed) {
    const processedMap = new Map(
        processed.map(
            item => [
                item.id,
                JSON.stringify(item)
            ]
        )
    );

    const remaining = kaloriLoadQueue()
        .filter(item => {
            const oldValue =
                processedMap.get(item.id);

            return oldValue !==
                JSON.stringify(item);
        });

    kaloriSaveQueue(remaining);
}

function kaloriApplyActions(list, actions) {
    const map = new Map(
        list.map(food => [food.id, food])
    );

    for (const action of actions) {
        if (action.action === 'delete') {
            map.delete(action.id);
            continue;
        }

        if (
            action.action === 'upsert' &&
            action.food
        ) {
            map.set(
                action.id,
                action.food
            );
        }
    }

    return Array.from(map.values());
}

async function kaloriGetRemoteFile() {
    const url =
        kaloriGithubApiUrl() +
        '?ref=' +
        encodeURIComponent(
            KALORI_GITHUB_CONFIG.branch
        ) +
        '&_=' +
        Date.now();

    const response = await fetch(url, {
        headers: kaloriGithubHeaders(),
        cache: 'no-store'
    });

    if (response.status === 404) {
        return {
            exists: false,
            sha: null,
            foods: null
        };
    }

    if (!response.ok) {
        const errorData =
            await response.json()
                .catch(() => ({}));

        throw new Error(
            errorData.message ||
            'GitHub okuma hatası (' +
            response.status +
            ')'
        );
    }

    const data = await response.json();

    const decoded = decodeKaloriBase64(
        data.content || ''
    );

    return {
        exists: true,
        sha: data.sha,
        foods: kaloriParseRemoteFoods(
            decoded
        )
    };
}

async function kaloriPutRemoteFile(
    list,
    sha
) {
    const document =
        kaloriCreateRemoteDocument(list);

    const body = {
        message:
            'Besin listesi güncellendi - ' +
            new Date().toISOString(),
        content: encodeKaloriBase64(
            JSON.stringify(
                document,
                null,
                2
            )
        ),
        branch:
            KALORI_GITHUB_CONFIG.branch
    };

    if (sha) {
        body.sha = sha;
    }

    const response = await fetch(
        kaloriGithubApiUrl(),
        {
            method: 'PUT',
            headers: {
                ...kaloriGithubHeaders(),
                'Content-Type':
                    'application/json'
            },
            body: JSON.stringify(body),
            cache: 'no-store'
        }
    );

    if (!response.ok) {
        const errorData =
            await response.json()
                .catch(() => ({}));

        const error = new Error(
            errorData.message ||
            'GitHub yazma hatası (' +
            response.status +
            ')'
        );

        error.status = response.status;
        throw error;
    }
}

function kaloriSaveFoodsLocally(list) {
    foods = list;

    localStorage.setItem(
        keyFoods,
        JSON.stringify(foods)
    );

    render();

    if (
        document.getElementById('foodList')
    ) {
        renderFoods();
    }
}

function kaloriSetSyncStatus(
    message,
    isError = false
) {
    const element =
        document.getElementById(
            'kaloriSyncStatus'
        );

    if (!element) {
        return;
    }

    element.textContent = message;
    element.style.color = isError
        ? '#c94c4c'
        : '#6f7d74';
}

async function syncKaloriFoods(
    showMessage = false
) {
    if (kaloriSyncRunning) {
        kaloriSyncAgain = true;
        return;
    }

    const token = getKaloriToken();

    if (!token) {
        const message =
            'APK içine GitHub tokenı eklenmemiş.';

        kaloriSetSyncStatus(
            message,
            true
        );

        if (showMessage) {
            alert(message);
        }

        return;
    }

    kaloriSyncRunning = true;
    kaloriSetSyncStatus(
        'Besin listesi eşitleniyor...'
    );

    try {
        let completed = false;
        let lastError = null;

        for (
            let attempt = 1;
            attempt <= 3;
            attempt++
        ) {
            try {
                const remote =
                    await kaloriGetRemoteFile();

                const actions =
                    kaloriLoadQueue();

                let mergedFoods =
                    remote.exists
                        ? remote.foods
                        : [...foods];

                mergedFoods =
                    kaloriApplyActions(
                        mergedFoods,
                        actions
                    );

                if (
                    !remote.exists ||
                    actions.length > 0
                ) {
                    await kaloriPutRemoteFile(
                        mergedFoods,
                        remote.sha
                    );
                }

                kaloriSaveFoodsLocally(
                    mergedFoods
                );

                kaloriClearProcessedActions(
                    actions
                );

                const now = new Date();

                localStorage.setItem(
                    KALORI_LAST_SYNC_KEY,
                    now.toISOString()
                );

                kaloriSetSyncStatus(
                    'Son eşitleme: ' +
                    now.toLocaleTimeString(
                        'tr-TR',
                        {
                            hour: '2-digit',
                            minute: '2-digit'
                        }
                    )
                );

                completed = true;
                lastError = null;
                break;
            } catch (error) {
                lastError = error;

                if (
                    (
                        error.status === 409 ||
                        error.status === 422
                    ) &&
                    attempt < 3
                ) {
                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                500 * attempt
                            )
                    );

                    continue;
                }

                throw error;
            }
        }

        if (!completed && lastError) {
            throw lastError;
        }

        if (showMessage) {
            toast(
                'Besin listesi eşitlendi'
            );
        }
    } catch (error) {
        kaloriSetSyncStatus(
            'Eşitleme başarısız: ' +
            error.message,
            true
        );

        if (showMessage) {
            alert(
                'Eşitleme başarısız: ' +
                error.message
            );
        }
    } finally {
        kaloriSyncRunning = false;

        if (
            kaloriSyncAgain ||
            kaloriLoadQueue().length > 0
        ) {
            kaloriSyncAgain = false;

            setTimeout(
                () => syncKaloriFoods(false),
                350
            );
        }
    }
}

function kaloriDiffAndQueue(
    before,
    after
) {
    const beforeMap = new Map(
        before.map(food => [
            food.id,
            food
        ])
    );

    const afterMap = new Map(
        after.map(food => [
            food.id,
            food
        ])
    );

    for (const food of after) {
        const oldFood =
            beforeMap.get(food.id);

        if (
            !oldFood ||
            JSON.stringify(oldFood) !==
                JSON.stringify(food)
        ) {
            kaloriQueueAction({
                action: 'upsert',
                id: food.id,
                food: food
            });
        }
    }

    for (const oldFood of before) {
        if (!afterMap.has(oldFood.id)) {
            kaloriQueueAction({
                action: 'delete',
                id: oldFood.id
            });
        }
    }
}

function kaloriInstallSyncHooks() {
    const originalSaveFood = saveFood;

    saveFood = function () {
        const before = JSON.parse(
            JSON.stringify(foods)
        );

        originalSaveFood();

        kaloriDiffAndQueue(
            before,
            foods
        );

        if (
            JSON.stringify(before) !==
            JSON.stringify(foods)
        ) {
            syncKaloriFoods(false);
        }
    };

    const originalRemoveFood = removeFood;

    removeFood = function (id) {
        const before = JSON.parse(
            JSON.stringify(foods)
        );

        originalRemoveFood(id);

        kaloriDiffAndQueue(
            before,
            foods
        );

        if (
            JSON.stringify(before) !==
            JSON.stringify(foods)
        ) {
            syncKaloriFoods(false);
        }
    };
}

function kaloriInstallSyncUi() {
    const manage =
        document.querySelector('.manage');

    if (!manage) {
        return;
    }

    const button =
        document.createElement('button');

    button.className =
        'btn soft wide';

    button.style.marginTop = '10px';

    button.textContent =
        '🔄 Besin listesini eşitle';

    button.onclick = function () {
        syncKaloriFoods(true);
    };

    const status =
        document.createElement('div');

    status.id = 'kaloriSyncStatus';
    status.style.textAlign = 'center';
    status.style.fontSize = '12px';
    status.style.marginTop = '7px';
    status.style.color = '#6f7d74';

    const oldSync =
        localStorage.getItem(
            KALORI_LAST_SYNC_KEY
        );

    if (oldSync) {
        const date = new Date(oldSync);

        status.textContent =
            'Son eşitleme: ' +
            date.toLocaleTimeString(
                'tr-TR',
                {
                    hour: '2-digit',
                    minute: '2-digit'
                }
            );
    } else {
        status.textContent =
            'Besin listesi henüz eşitlenmedi';
    }

    manage.insertAdjacentElement(
        'afterend',
        button
    );

    button.insertAdjacentElement(
        'afterend',
        status
    );
}

kaloriInstallSyncHooks();
kaloriInstallSyncUi();

setTimeout(
    () => syncKaloriFoods(false),
    400
);
