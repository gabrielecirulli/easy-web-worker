import { EasyWebWorkerMessage } from './EasyWebWorkerMessage';
import { easyWebWorkerFactory } from './EasyWebWorkerFactory';
import { generatedId } from './EasyWebWorkerFixtures';
import {
  EasyWebWorkerBody,
  IMessageData,
  IMessagePromise,
  IWorkerConfig,
} from './EasyWebWorkerTypes';

/**
 * This is a class to create global-store objects
 * @template IPayload - Indicates if your WORKERS messages requires a parameter to be provided, NULL indicates they doesn't
 * @template IResult - Indicates if your WORKERS messages has a result... NULL indicates all you messages are Promise<void>
 * @param {EasyWebWorkerBody<IPayload, IResult> | EasyWebWorkerBody<IPayload, IResult>[]} workerBody -
 * this parameter should be a function or set of functions that will become the body of your Web-Worker
 * IMPORTANT!! all WORKERS content is gonna be transpiled on run time, so you can not use any variable, method of resource that weren't included into the WORKER.
 * the above the reason of why we are injecting all worker context into the MessageBody Callbacks, so,
 * you could easily identify what is on the context of your Worker.
 * @param {Partial<IWorkerConfig>} WorkerConfig - You could add extra configuration to your worker,
 * consult IWorkerConfig description to have more information
 * */

export class EasyWebWorker<IPayload = null, IResult = void> {
  public name: string;

  /**
   * @deprecated Directly modifying the worker may lead to unexpected behavior. Use it only if you know what you are doing.
   */
  public worker: Worker;

  /**
   * These where send to the worker but not yet resolved
   */
  private messagesQueue: Map<string, EasyWebWorkerMessage<IPayload, IResult>> =
    new Map();

  /**
   * This is the URL of the worker file
   */
  public workerUrl: string;

  protected scripts: string[] = [];

  protected get isExternalWorkerFile(): boolean {
    return typeof this.workerBody === 'string';
  }

  constructor(
    /**
     * this parameter should be a function or set of functions that will become the body of your Web-Worker
     * IMPORTANT!! all WORKERS content is gonna be transpiled on run time, so you can not use any variable, method of resource that weren't included into the WORKER.
     * the above the reason of why we are injecting all worker context into the MessageBody Callbacks, so,
     * you could easily identify what is on the context of your Worker.
     */
    protected workerBody:
      | EasyWebWorkerBody<IPayload, IResult>
      | EasyWebWorkerBody<IPayload, IResult>[]
      | string,

    /**
     * You could import scripts into your worker, this is useful if you want to use external libraries
     */
    { scripts = [], name }: Partial<IWorkerConfig> = {}
  ) {
    this.name = name || generatedId();
    this.scripts = scripts;
    this.worker = this.createWorker();
  }

  private RemoveMessageFromQueue(messageId: string) {
    this.messagesQueue.delete(messageId);
  }

  /**
   * Categorizes the worker response and executes the corresponding callback
   */
  private executeMessageCallback(
    event: Partial<
      Omit<MessageEvent<IMessageData<IPayload>>, 'data'> & {
        data: Partial<MessageEvent<IMessageData<IPayload>>['data']>;
      }
    >
  ) {
    const message: EasyWebWorkerMessage<IPayload, IResult> | null =
      this.messagesQueue.get(event.data.messageId) ?? null;

    if (!message) return;

    const { payload, reason, wasCanceled, progressPercentage } = event.data;

    // worker was disposed before the message was resolved
    if (!this.worker) {
      this.RemoveMessageFromQueue(message.messageId);

      return;
    }

    // execute progress callback
    if (progressPercentage !== undefined) {
      message.reportProgress(progressPercentage);

      return;
    }

    // remove message from queue
    this.RemoveMessageFromQueue(message.messageId);
    message.wasCompleted = false;

    if (wasCanceled) {
      message.cancel(reason);

      return;
    }

    if (reason) {
      message.reject(reason);

      return;
    }

    message.wasCompleted = true;

    // resolve message with the serialized payload
    message.resolve(
      ...((payload ?? []) as unknown as IResult extends void
        ? [null?]
        : [IResult])
    );
  }

  protected getWorkerUrl(): string {
    if (this.isExternalWorkerFile) {
      return this.workerBody as string;
    }

    return easyWebWorkerFactory.blobWorker<IPayload, IResult>(
      this.workerBody as
        | EasyWebWorkerBody<IPayload, IResult>
        | EasyWebWorkerBody<IPayload, IResult>[],
      this.scripts
    );
  }

  protected createWorker(): Worker {
    this.workerUrl = this.getWorkerUrl();

    const worker = new Worker(this.workerUrl, {
      name: this.name,
    });

    worker.onmessage = (event: MessageEvent<IMessageData<IPayload>>) => {
      this.executeMessageCallback(event);
    };

    worker.onerror = (reason) => {
      this.executeMessageCallback({ data: { reason } });
    };

    return worker;
  }

  /**
   * Terminates the worker and remove all messages from the queue
   * Execute the cancel callback of each message in the queue if provided
   * @param {unknown} reason - reason why the worker was terminated
   */
  public cancelAll(reason?: unknown): void {
    this.worker?.terminate();

    const messages = Array.from(this.messagesQueue.values());

    messages.forEach((message) => message.cancel(reason));

    this.messagesQueue = new Map();
  }

  /**
   * Send a message to the worker queue
   * @param {IPayload} payload - whatever json data you want to send to the worker
   * @returns {IMessagePromise<IResult>} generated defer that will be resolved when the message completed
   */
  public send = ((
    ...payload: IPayload extends null ? [null?] : [IPayload]
  ): IMessagePromise<IResult> => {
    const [$payload] = payload as [IPayload];
    const message = new EasyWebWorkerMessage<IPayload, IResult>($payload);

    const { messageId } = message;

    this.messagesQueue.set(message.messageId, message);

    this.worker?.postMessage({
      messageId,
      payload: $payload,
    });

    return message.decoupledPromise.promise;
  }) as unknown as IPayload extends null
    ? () => IMessagePromise<IResult>
    : (payload: IPayload) => IMessagePromise<IResult>;

  /**
   * This method terminate all current messages and send a new one to the worker queue
   * @param {IPayload} payload - whatever json data you want to send to the worker, should be serializable
   * @param {unknown} reason - reason why the worker was terminated
   * @returns {IMessagePromise<IResult>} generated defer that will be resolved when the message completed
   */
  public override = ((
    ...[payload, reason]: IPayload extends null
      ? [null?, unknown?]
      : [IPayload, unknown?]
  ): IMessagePromise<IResult> => {
    this.cancelAll(reason);

    return this.send(...([payload] as [IPayload]));
  }) as unknown as IPayload extends null
    ? (reason?: unknown) => IMessagePromise<IResult>
    : (payload: IPayload, reason?: unknown) => IMessagePromise<IResult>;

  /**
   * This method will alow the current message to be completed and send a new one to the worker queue after it, all the messages after the current one will be canceled
   * @param {IPayload} payload - whatever json data you want to send to the worker should be serializable
   * @param {unknown} reason - reason why the worker was terminated
   * @returns {IMessagePromise<IResult>} generated defer that will be resolved when the message completed
   */
  public overrideAfterCurrent = ((
    ...[payload, reason]: IPayload extends null
      ? [null?, unknown?]
      : [IPayload, unknown?]
  ): IMessagePromise<IResult> => {
    if (this.messagesQueue.size) {
      const [firstItem] = this.messagesQueue;
      const [, currentMessage] = firstItem;

      this.messagesQueue.delete(currentMessage.messageId);

      this.cancelAll(reason);

      this.messagesQueue.set(currentMessage.messageId, currentMessage);
    }

    return this.send(...([payload] as [IPayload]));
  }) as unknown as IPayload extends null
    ? (reason?: unknown) => IMessagePromise<IResult>
    : (payload: IPayload, reason?: unknown) => IMessagePromise<IResult>;

  /**
   * This method will remove the WebWorker and the BlobUrl
   */
  public dispose(): void {
    this.cancelAll();

    URL.revokeObjectURL(this.workerUrl);

    this.worker = null;
  }
}

export default EasyWebWorker;
