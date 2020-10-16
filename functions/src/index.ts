import { PubSub } from "@google-cloud/pubsub"
import Axios from "axios"
import * as admin from "firebase-admin"
import * as functions from "firebase-functions"
import Telegraf from "telegraf"
import serviceAccount from "./serviceAccountKey.json"
import { FirestoreImageDoc, LineSticker, LineStickerSet } from "./typings"
import { BotError, concurrentDo, delay, formattedName, isLineStickerSet, normalizeImage } from "./utils"

const welcomeText =
    "Hello! Send me a JSON file generated from https://stickers-l2t-editor.vercel.app.\
    I can create the sticker set for you!"

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount as any),
    databaseURL: JSON.parse(process.env.FIREBASE_CONFIG!).databaseURL,
})

const db = admin.firestore()
const token = functions.config().bot.token
const secretPath = functions.config().bot.secret_path
const bot = new Telegraf(token)
const axios = Axios.create({ responseType: "arraybuffer" })
const processingChat: Record<number, boolean> = {}

bot.start((ctx) => ctx.reply(welcomeText))

bot.on("document", async (ctx) => {
    const userId = ctx.from?.id!

    try {
        if (processingChat[userId]) {
            throw new BotError("I'm already working hard!")
        } else {
            processingChat[userId] = true
            await ctx.reply("OK, please wait a moment. The process usually takes one minute or longer.")
        }

        const stickerSet = await fetchStickerSetObject()
        const setName = formattedName(stickerSet.name)
        const title = `${stickerSet.name} (by ${stickerSet.author})`

        const existingImageIds = await retrieveImageIds()
        const stickersAlreadyUploaded: LineSticker[] = []
        const stickersToBeUploaded: LineSticker[] = []
        stickerSet.stickers.forEach((sticker) => {
            if (existingImageIds[sticker.id]) {
                sticker.fileId = existingImageIds[sticker.id]
                stickersAlreadyUploaded.push(sticker)
            } else stickersToBeUploaded.push(sticker)
        })

        await downloadImages()
        await processImages()
        await uploadStickers()
        await addImageIds(stickersToBeUploaded)
        await delay(1000)
        await createStickerSet()
        await delay(8000)
        await addStickers()

        processingChat[userId] = false
        await log(`Succeeded!🥳 Here's your sticker set: [${stickerSet.name}](https://t.me/addstickers/${setName})`)

        async function fetchStickerSetObject(): Promise<LineStickerSet> {
            const link = await ctx.telegram.getFileLink(ctx.message?.document?.file_id!)

            const json = ((await axios.get(link)).data as Buffer).toString("utf8")
            const result = JSON.parse(json)
            if (isLineStickerSet(result)) return result
            else throw new BotError("This file seems wrong... Please send a correct file.")
        }

        async function retrieveImageIds(): Promise<Record<number, string>> {
            const snapshot = await db.collection("images").get()
            const result: Record<number, string> = {}
            snapshot.docs.forEach((doc) => {
                result[parseInt(doc.id)] = (doc.data() as FirestoreImageDoc).fileId
            })
            return result
        }

        async function downloadImages(): Promise<void> {
            await log("Downaloding images...")
            await concurrentDo(
                stickersToBeUploaded.map((sticker) => () =>
                    downloadFile(sticker.url).then((image) => {
                        sticker.image = image
                    })
                ),
                5,
                300,
                20000
            )
            await log("All images downloaded.")

            async function downloadFile(url: string): Promise<Buffer> {
                function __downloadFile() {
                    return axios.get(url).then((response) => response.data)
                }

                let times = 0
                while (times < 3) {
                    try {
                        return await __downloadFile()
                    } catch {
                        times++
                    }
                }
                console.log(`Failed: ${url}.`)
                throw new BotError("Downloading image failed.")
            }
        }

        async function processImages(): Promise<void> {
            await log("Processing images...")
            await Promise.all(
                stickersToBeUploaded.map(async (sticker) => {
                    sticker.image = await normalizeImage(sticker.image!)
                })
            )
            await log("All images processed.")
        }

        async function uploadStickers(): Promise<void> {
            await log("Uploading images...")
            await concurrentDo(
                stickersToBeUploaded.map((sticker) => () => uploadSticker(sticker)),
                5,
                1800,
                60000
            )
            await log("All images uploaded.")

            async function uploadSticker(sticker: LineSticker): Promise<void> {
                let error: any
                let times = 0
                while (times < 3) {
                    try {
                        const { file_id } = await __uploadSticker()
                        sticker.fileId = file_id
                        // console.log(`Finished: ${sticker.id}.`)
                        return
                    } catch (err) {
                        times++
                        error = err
                        await delay(1000)
                    }
                }
                if (error) console.log(error)
                throw new BotError("Uploading image failed.")

                function __uploadSticker() {
                    return ctx.telegram.uploadStickerFile(userId, {
                        source: sticker.image!,
                    })
                }
            }
        }

        async function addImageIds(stickers: LineSticker[]): Promise<void> {
            const batch = db.batch()
            stickers.forEach((sticker) => {
                if (sticker.fileId) {
                    const ref = db.collection("images").doc(sticker.id.toString())
                    const data: FirestoreImageDoc = { fileId: sticker.fileId }
                    batch.set(ref, data)
                }
            })
            await batch.commit()
        }

        async function createStickerSet(): Promise<void> {
            const firstSticker = stickerSet.stickers[0]
            await ctx.telegram.createNewStickerSet(userId, setName, title, {
                png_sticker: firstSticker.fileId!,
                emojis: firstSticker.emojis,
            } as any)
            await log(`Sticker set created.`)
        }

        async function addStickers(): Promise<void> {
            await log("Adding images to the set...")
            await concurrentDo(
                stickerSet.stickers.slice(1).map((sticker) => () => addSticker(sticker)),
                2,
                1500,
                80000
            )
            await log("Images added to the set.")

            async function addSticker(sticker: LineSticker): Promise<void> {
                let error: any
                let times = 0
                while (times < 5) {
                    try {
                        await __addSticker()
                        // console.log(`Added: ${sticker.id}.`)
                        return
                    } catch (err) {
                        times++
                        error = err

                        await delay(1000)
                    }
                }
                if (error) console.log(error)
                throw new BotError("Adding image failed.")

                function __addSticker() {
                    return ctx.telegram.addStickerToSet(
                        userId,
                        setName,
                        {
                            png_sticker: sticker.fileId!,
                            emojis: sticker.emojis,
                        } as any,
                        false
                    )
                }
            }
        }

        async function log(str: string): Promise<void> {
            await ctx.reply(str, { parse_mode: "Markdown" })
            console.log(`[${userId}] ${str}`)
        }
    } catch (err) {
        processingChat[userId] = false
        if (err instanceof BotError) await ctx.reply(err.message)
        else {
            console.log(err)
            await ctx.reply(`Something goes wrong...😣 Please try again.`)
        }
    }
})

const pubsub = new PubSub()
const topicName = "main"
const bkgRuntimeOptions: functions.RuntimeOptions = {
    timeoutSeconds: 180,
    memory: "256MB",
}

export const listen = functions.https.onRequest(async (req, res) => {
    const path = req.path.trim()
    if (path === secretPath) {
        const topic = pubsub.topic(topicName)
        const message = Buffer.from(JSON.stringify(req.body), "utf-8")

        try {
            await topic.publish(message)
            console.log("Received request and published pubsub message.")
        } catch (err) {
            console.log(err)
        } finally {
            res.sendStatus(200)
        }
    } else res.sendStatus(404)
})

export const background = functions
    .runWith(bkgRuntimeOptions)
    .pubsub.topic(topicName)
    .onPublish(async (message) => {
        await bot.handleUpdate(message.json)
    })
