/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Sofia Lima
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Link } from "@components/Link";
import PluginModal from "@components/PluginSettings/PluginModal";
import { Logger } from "@utils/Logger";
import { Devs } from "@utils/constants";
import { isTruthy } from "@utils/guards";
import { openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { filters, findByCodeLazy, mapMangledModuleLazy } from "@webpack";
import { FluxDispatcher, Forms, Toasts, UserStore } from "@webpack/common";

interface ActivityAssets {
    large_image: string;
    large_text?: string | null;
    small_image: string;
    small_text: string;
};

interface Activity {
    state: string;
    details?: string;
    timestamps?: {
        start?: number;
        end?: number;
    };
    assets: ActivityAssets;
    buttons?: Array<string>;
    name: string;
    application_id: string;
    metadata?: {
        button_urls?: Array<string>;
    };
    type: number;
    flags: number;
}

const enum ActivityType {
    PLAYING = 0,
    LISTENING = 2,
    WATCHING = 3,
    COMPETING = 5
}

const enum ActivityFlag {
    INSTANCE = 1 << 0
}

interface SocketMessage {
    type: string;
    data: any;
}

interface PublicApp {
    id: string;
    name: string;
    icon: string;
    statusType: ActivityType | undefined;
    flags: number;
}

let ws: WebSocket;
let isReconnecting = false;
const logger = new Logger("Vencord-PreMiD", "#8fd0ff");

const lookupRpcApp = findByCodeLazy(".APPLICATION_RPC(");
const assetManager = mapMangledModuleLazy(
    "getAssetImage: size must === [number, number] for Twitch",
    {
        getAsset: filters.byCode("apply("),
    }
);

const apps: any = {};
async function getApp(applicationId: string): Promise<PublicApp> {
    if (apps[applicationId]) return apps[applicationId];
    const socket: any = {};
    debugLog(`Looking up ${applicationId}`);
    await lookupRpcApp(socket, applicationId);
    debugLog(`Lookup finished for ${socket.application.name}`);
    let activityType = await determineStatusType(socket.application);
    debugLog(`Activity type for ${socket.application.name}: ${activityType}`);
    socket.application.statusType = activityType ? activityType : settings.store.statusType;
    apps[applicationId] = socket.application;
    return socket.application;
}
async function getAppAsset(appId: string, key: string): Promise<string> {
    return (await assetManager.getAsset(appId, [key, undefined]))[0];
}

function setActivity(activity: Activity | undefined) {
    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity,
        socketId: "PreMiD",
    });
}

const settings = definePluginSettings({
    showButtons: {
        description: "Show buttons",
        type: OptionType.BOOLEAN,
        default: false,
    },
    manualShare: {
        description: "Share status manually",
        type: OptionType.BOOLEAN,
        default: false,
    },
    hideViewChannel: {
        description: "YouTube: Hide view channel button",
        type: OptionType.BOOLEAN,
        default: false,
    },
    statusType: {
        description: "Fallback status type",
        type: OptionType.SELECT,
        options: [
            {
                label: "Playing",
                value: ActivityType.PLAYING,
            },
            {
                label: "Watching",
                value: ActivityType.WATCHING,
            },
            {
                label: "Listening",
                value: ActivityType.LISTENING,
            },
            {
                label: "Competing",
                value: ActivityType.COMPETING,
            }
        ],
    }
});

const shig = definePlugin({
    name: "vcMiD",
    tags: ["presence", "premid", "rpc"],
    description: "An overengineered PreMiD app replacement. Supports watching/listening status. Requires extra setup (see about)",
    authors: [Devs.Animal],
    version: "1.2.0",
    toolboxActions: {
        "Reconnect PreMiD": () => {
            isReconnecting = true;
            shig.stop();
            shig.start();
        },
        "Settings": () => {
            openModal(modalProps => {
                return <PluginModal {...modalProps} plugin={shig as any} onRestartNeeded={() => null} />;
            });
        }
    },

    settingsAboutComponent: () => (
        <>
            <Forms.FormTitle tag="h3">How to use this plugin</Forms.FormTitle>
            <Forms.FormText>
                - Install the <Link href="https://premid.app/downloads#ext-downloads">PreMiD browser extension</Link>

                - Download the bridge script (link soon) - this is needed because of how Vencord works (built in plugins + no node stuff)

                That is all you need, this plugin+bridge replicates their electron tray process so no need to download that.
            </Forms.FormText>
        </>
    ),

    settings,

    start() {
        this.initShidd();
    },

    stop() {
        this.clearActivity();
    },

    async initShidd() {
        const user = UserStore.getCurrentUser();
        const currentUser = {
            type: "currentUser",
            user: user
        };
        if (ws) ws.close();
        ws = new WebSocket("ws://127.0.0.1:4020");

        ws.onopen = () => {
            showToast("PreMiD Connected");
        };

        ws.onmessage = async (event) => {
            debugLog(`Raw Receive: ${event.data}`);
            const message: SocketMessage = JSON.parse(event.data);
            switch (message.type) {
                case "getCurrentUser":
                    logger.log(`Sending currentUser`);
                    ws.send(JSON.stringify(currentUser));
                    break;
                case "setActivity":
                    debugLog(`Received setActivity for ${message.data.application_id}`);
                    let activity = await this.getActivity(message.data);
                    setActivity(activity);
                    break;
                case "clearActivity":
                    debugLog("Clearing activity");
                    this.clearActivity();
                    break;
            }
        };

        ws.onclose = () => {
            logger.log("PreMiD disconnected, clearing activity");
            this.clearActivity();
        };


        const connectionSuccessful = await new Promise(res => setTimeout(() => res(ws.readyState === WebSocket.OPEN), 1000)); // check if open after 1s
        if (!connectionSuccessful) {
            logger.error("Failed to connect to PreMiD.");
            if (isReconnecting) {
                showNotification({
                    title: "[PreMiD:Bridge] Connection failed",
                    body: "Make sure both the bridge and PreMiD extension are running.",
                    noPersist: true,
                    onClick() {
                        isReconnecting = true;
                        shig.start();
                    },
                });
                isReconnecting = false;
            }
        };
    },

    clearActivity() {
        FluxDispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity: null,
            socketId: "PreMiD",
        });
    },

    async getActivity(pmActivity: Activity): Promise<Activity | undefined> {
        const appInfo = await getApp(pmActivity.application_id);
        // debugLog(JSON.parse(JSON.stringify(act)));

        if (!appInfo.name || appInfo.name === "PreMiD") return;


        const activity: Activity = {
            application_id: pmActivity.application_id,
            name: appInfo.name,
            details: pmActivity.details,
            state: pmActivity.state,
            type: appInfo.statusType || ActivityType.PLAYING,
            flags: ActivityFlag.INSTANCE,
            assets: {
                large_image: await getAppAsset(pmActivity.application_id, pmActivity.assets?.large_image ?? "guh"),
                small_image: await getAppAsset(pmActivity.application_id, pmActivity.assets?.small_image ?? "guhh"),
                small_text: pmActivity.assets?.small_text || "hello there :3",
            }
        };

        if (activity.type === ActivityType.PLAYING) {
            activity.assets = {
                large_image: await getAppAsset(pmActivity.application_id, pmActivity.assets?.large_image ?? "guh"),
                large_text: `vcMiD v${this.version}`,
                small_image: await getAppAsset(pmActivity.application_id, pmActivity.assets?.small_image ?? "guhh"),
                small_text: pmActivity.assets?.small_text || "hello there :3",
            };
        }

        if (settings.store.showButtons && pmActivity.buttons) {
            if (appInfo.name == "YouTube" && settings.store.hideViewChannel) {
                activity.buttons = [pmActivity.buttons[0]];
                if (activity.metadata && pmActivity.metadata && pmActivity.metadata.button_urls) {
                    activity.metadata.button_urls = [pmActivity.metadata.button_urls[0]];
                }
            } else {
                activity.buttons = pmActivity.buttons;
                activity.metadata = pmActivity.metadata;
            }
        }

        // horror
        if (pmActivity.timestamps) {
            let { start, end } = pmActivity.timestamps;
            if (start && end) {
                activity.timestamps = pmActivity.timestamps;
            } else if (start) {
                if (activity.type == ActivityType.WATCHING) {
                    activity.assets.large_text = `${formatTime(Math.floor(Date.now() / 1000) - start)} elapsed`;
                }
                activity.timestamps = {
                    start: start
                };
            } else if (end) {
                if (activity.type == ActivityType.WATCHING) {
                    activity.assets.large_text = `${formatTime(end - Math.floor(Date.now() / 1000))} left`;
                }
                activity.timestamps = {
                    ...activity.timestamps,
                    end: end
                };
            }
        }


        for (const k in activity) {
            if (k === "type") continue; // without type, the presence is considered invalid.
            const v = activity[k];
            if (!v || v.length === 0)
                delete activity[k];
        }

        debugLog(JSON.parse(JSON.stringify(activity)));

        return activity;
    }
});


// Watching status doesnt support timestamps LOL
function formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

async function determineStatusType(info: PublicApp): Promise<ActivityType | undefined> {
    let firstCharacter = info.name.charAt(0);
    if (firstCharacter.match(/[a-zA-Z]/)) {
        firstCharacter = firstCharacter;
    } else if (firstCharacter.match(/[0-9]/)) {
        firstCharacter = "0-9";
    } else {
        firstCharacter = "%23"; // URL encoded version of #
    }

    const res = await fetch(`https://raw.githubusercontent.com/PreMiD/Presences/main/websites/${firstCharacter}/${info.name}/metadata.json`);
    if (!res.ok) return ActivityType.PLAYING;

    try {
        const metadata = await res.json();
        switch (metadata.category) {
            case 'socials':
                if (metadata.tags.includes('video')) {
                    return ActivityType.WATCHING;
                }
                break;
            case 'anime':
                if (metadata.tags.some(tag => ['video', 'media', 'streaming'].includes(tag))) {
                    return ActivityType.WATCHING;
                }
                break;
            case 'music':
                return ActivityType.LISTENING;
            case 'videos':
                return ActivityType.WATCHING;
        }
    } catch (e) {
        console.error(e);
        return ActivityType.PLAYING;
    }
}

function debugLog(msg: string) {
    if (IS_DEV) console.log(msg);
}

function showToast(msg: string, type = Toasts.Type.SUCCESS) {
    Toasts.show({
        message: msg,
        type: type,
        id: Toasts.genId(),
        options: {
            duration: 5000,
            position: Toasts.Position.TOP
        }
    });
}

export default shig;

