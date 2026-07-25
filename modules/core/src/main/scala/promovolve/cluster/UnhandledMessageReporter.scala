package promovolve.cluster

import org.apache.pekko.actor.UnhandledMessage
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.actor.typed.scaladsl.adapter.*

/**
 * Makes the "actor stuck in a state that can't handle the message"
 * class visible. Pekko typed silently drops a message that lands in a
 * behavior with no handler for it (publishing UnhandledMessage at
 * DEBUG) — an actor wedged in the wrong state eats its mailbox forever
 * with zero prod-level trace. This per-node listener re-logs every
 * unhandled message at WARN with the recipient's path and the message
 * class: a healthy cluster prints nothing; a wedged actor names itself
 * on the first dropped message.
 */
object UnhandledMessageReporter {

  def init(system: ActorSystem[?]): Unit = {
    val listener = system.systemActorOf(
      Behaviors.receive[UnhandledMessage] { (ctx, um) =>
        ctx.log.warn(
          "UNHANDLED MESSAGE: {} dropped by {} — actor is in a state with no handler for it",
          um.message.getClass.getName,
          um.recipient.path.toStringWithoutAddress
        )
        Behaviors.same
      },
      "unhandled-message-reporter"
    )
    system.toClassic.eventStream.subscribe(listener.toClassic, classOf[UnhandledMessage])
  }
}
