package promovolve.auction

import org.apache.pekko.actor.typed.pubsub.Topic
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.actor.typed.{ ActorRef, ActorSystem, Behavior, SupervisorStrategy }
import org.apache.pekko.cluster.typed.{ ClusterSingleton, ClusterSingletonSettings, SingletonActor }

import scala.concurrent.duration.*

/**
 * Outcome-level demand liveness — the mechanism-agnostic clog detector.
 *
 * Every clog this platform has produced — pacing arithmetic, floor
 * self-strangulation, shrunk bidder registries, poisoned serve state,
 * a bidder stripe stranded on the quorum pod — violated one invariant,
 * whatever its mechanism: *a category the auction ASKS must eventually
 * ANSWER*. The per-mechanism alarms (BATCH PACING, FLOOR-BLOCKED,
 * PARTIAL PUSH, SERVE-PICK, BIDDER STRIPE UNACKED) say WHICH disease;
 * this singleton says THAT a disease exists — including ones that
 * don't exist yet.
 *
 * Design is deliberately Pekko-native (no DB tables, no polling): the
 * auctioneer already knows, per auction, which categories answered and
 * which stayed silent — it publishes that fact to a topic, and this
 * cluster singleton folds the stream into per-(site, category) state.
 * Topics ride a different delivery path than cluster sharding, so the
 * monitor does not share fate with the sharded-entity messaging whose
 * failures it watches. A single silent auction is noise (aggregator
 * timeout, shard handoff); silence PERSISTING across auctions for
 * [[AlarmAfter]] is a stall, warned once per tick until it recovers —
 * the same repeat-while-broken contract as DEMAND REGISTRATION
 * DEGRADED.
 */
object DemandLivenessMonitor {

  /**
   * Per-auction, per-category outcome published by AuctioneerEntity.
   * Primitives only — this crosses nodes via the topic.
   */
  final case class CategoryAuctionReport(siteId: String, categoryId: String, answered: Boolean)
      extends promovolve.CborSerializable

  sealed trait Command
  case object Stop extends Command
  private final case class WrappedReport(report: CategoryAuctionReport) extends Command
  private case object Tick extends Command

  /** Silence must persist this long before the first WARN — filters shard-handoff blips. */
  val AlarmAfter: FiniteDuration = 5.minutes

  /** Drop pairs that stop reporting entirely (page declassified, site removed). */
  val ForgetAfter: FiniteDuration = 24.hours

  private final case class PairState(
      lastReportMs: Long,
      silentSinceMs: Long, // 0 = currently answering
      alarmed: Boolean
  )

  def singletonInit(
      system: ActorSystem[?],
      livenessTopic: ActorRef[Topic.Command[CategoryAuctionReport]]
  ): ActorRef[Command] = ClusterSingleton(system).init(
    SingletonActor(
      Behaviors
        .supervise(apply(livenessTopic))
        .onFailure[Exception](SupervisorStrategy.restart),
      "demand-liveness-monitor"
    ).withStopMessage(Stop)
      .withSettings(ClusterSingletonSettings(system).withRole("singleton"))
  )

  private def apply(
      livenessTopic: ActorRef[Topic.Command[CategoryAuctionReport]]
  ): Behavior[Command] = Behaviors.setup { ctx =>
    Behaviors.withTimers { timers =>
      val adapter = ctx.messageAdapter[CategoryAuctionReport](WrappedReport(_))
      livenessTopic ! Topic.Subscribe(adapter)
      timers.startTimerAtFixedRate(Tick, 1.minute)
      ctx.log.info("DemandLivenessMonitor started (alarm after {}, tick 60s)", AlarmAfter)

      def behavior(pairs: Map[(String, String), PairState]): Behavior[Command] =
        Behaviors.receiveMessage {
          case WrappedReport(r) =>
            val key = (r.siteId, r.categoryId)
            val now = System.currentTimeMillis()
            val prev = pairs.get(key)
            val next =
              if (r.answered) {
                prev.filter(_.alarmed).foreach { p =>
                  ctx.log.warn(
                    "DEMAND-LIVENESS RECOVERED: category={} site={} answering again after {}s silent",
                    r.categoryId,
                    r.siteId,
                    (now - p.silentSinceMs) / 1000
                  )
                }
                PairState(lastReportMs = now, silentSinceMs = 0L, alarmed = false)
              } else {
                val since = prev.map(_.silentSinceMs).filter(_ > 0L).getOrElse(now)
                PairState(lastReportMs = now, silentSinceMs = since, alarmed = prev.exists(_.alarmed))
              }
            behavior(pairs.updated(key, next))

          case Tick =>
            val now = System.currentTimeMillis()
            val alarmMs = AlarmAfter.toMillis
            var updated = pairs
            pairs.foreach { case (key @ (site, cat), p) =>
              if (p.silentSinceMs > 0L && now - p.silentSinceMs >= alarmMs) {
                // Repeat once per tick while broken — a recurring line IS
                // the alarm; one line that stops is a healed blip.
                ctx.log.warn(
                  "DEMAND-LIVENESS STALLED: category={} site={} — auctions have asked this category for {}m with zero bidder responses; its registered demand is not reaching auctions (check BIDDER STRIPE UNACKED for the stripe, heal = bounce the pod hosting its shard)",
                  cat,
                  site,
                  (now - p.silentSinceMs) / 60000
                )
                updated = updated.updated(key, p.copy(alarmed = true))
              }
              if (now - p.lastReportMs > ForgetAfter.toMillis)
                updated = updated - key
            }
            behavior(updated)

          case Stop =>
            Behaviors.stopped
        }

      behavior(Map.empty)
    }
  }
}
