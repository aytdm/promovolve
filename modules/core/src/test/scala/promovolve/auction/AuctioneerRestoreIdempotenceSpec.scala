package promovolve.auction

import com.typesafe.config.ConfigFactory
import org.apache.pekko.actor.testkit.typed.scaladsl.{ ActorTestKit, TestProbe }
import org.apache.pekko.actor.typed.ActorRef
import org.apache.pekko.actor.typed.pubsub.Topic
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.cluster.sharding.typed.scaladsl.{ ClusterSharding, Entity }
import org.apache.pekko.cluster.typed.{ Cluster, Join }
import org.scalatest.BeforeAndAfterAll
import org.scalatest.matchers.should.Matchers
import org.scalatest.wordspec.AnyWordSpec
import promovolve.*
import promovolve.advertiser.CampaignEntity
import promovolve.publisher.SiteEntity
import promovolve.publisher.delivery.AdServer

import java.time.Instant
import scala.concurrent.duration.*

/**
 * RestoreClassifications is IDEMPOTENT: SiteEntity resends the full
 * classification map on its periodic refresh tick (healing an auctioneer
 * incarnation that spawned empty between SiteEntity recoveries — live
 * 2026-07-13), so a resend of entries the auctioneer already holds must
 * restore nothing: no MarkClassified to AdServer, no re-auction kick.
 * Only strictly NEWER timestamps (or unseen URLs) restore.
 *
 * Timing note: scheduleReauction is debounced 1s and every restore resets
 * the timer, so all assertions below run before any auction machinery
 * (which this harness doesn't stub beyond AdServer) can fire.
 */
class AuctioneerRestoreIdempotenceSpec extends AnyWordSpec with Matchers with BeforeAndAfterAll {

  private val testConfig = ConfigFactory.parseString(
    """
      |pekko {
      |  loglevel = "WARNING"
      |  # Two shard regions (AdServer + the SiteEntity stub) push the
      |  # cluster teardown past the testkit's 10s default.
      |  actor.testkit.typed.system-shutdown-default = 60s
      |  actor {
      |    provider = "cluster"
      |    serializers {
      |      jackson-cbor = "org.apache.pekko.serialization.jackson.JacksonCborSerializer"
      |    }
      |    serialization-bindings {
      |      "promovolve.CborSerializable" = jackson-cbor
      |    }
      |  }
      |  remote.artery {
      |    canonical.hostname = "127.0.0.1"
      |    canonical.port = 0
      |  }
      |  cluster {
      |    seed-nodes = []
      |    downing-provider-class = "org.apache.pekko.cluster.sbr.SplitBrainResolverProvider"
      |  }
      |  persistence {
      |    state.plugin = "pekko.persistence.testkit.state"
      |    journal.plugin = "pekko.persistence.journal.inmem"
      |  }
      |}
      |""".stripMargin
  )

  val testKit: ActorTestKit = ActorTestKit(testConfig)
  given system: org.apache.pekko.actor.typed.ActorSystem[?] = testKit.system

  private val cluster = Cluster(testKit.system)
  cluster.manager ! Join(cluster.selfMember.address)

  lazy val sharding: ClusterSharding = ClusterSharding(testKit.system)

  val adServerProbe: TestProbe[AdServer.Command] =
    testKit.createTestProbe[AdServer.Command]()
  sharding.init(Entity(AdServer.TypeKey)(_ =>
    Behaviors.receiveMessage[AdServer.Command] { msg =>
      adServerProbe.ref ! msg
      Behaviors.same
    }
  ))

  // The auctioneer's setup block tells SiteEntity.AuctioneerStarted — an
  // unregistered type key would throw and kill the entity at spawn.
  sharding.init(Entity(SiteEntity.TypeKey)(_ => Behaviors.ignore[SiteEntity.Command]))

  private val budgetTopic: ActorRef[Topic.Command[BudgetEvent]] =
    testKit.spawn(Behaviors.ignore[Topic.Command[BudgetEvent]])

  override def afterAll(): Unit = testKit.shutdownTestKit()

  // Timestamps must be RELATIVE TO NOW: restore drops anything older than
  // classificationFreshnessWindow (48h by default), so the fixed epoch
  // values this spec once used (ts=1000 → 1970) would now be filtered as
  // stale and restore nothing.
  private val nowMs: Long = System.currentTimeMillis()
  private val freshMs: Long = nowMs - 1.hour.toMillis
  private val newerMs: Long = nowMs - 30.minutes.toMillis
  private val staleMs: Long = nowMs - 72.hours.toMillis

  private def entry(ts: Long): SiteEntity.ClassificationEntry =
    SiteEntity.ClassificationEntry(
      categories = Map("100" -> 0.9),
      slots = Vector(
        SiteEntity.PersistedSlot(
          slotId = "slot-1",
          width = 300,
          height = 250,
          declaredSizes = Vector(SiteEntity.PersistedAdSize(300, 250)),
          prior = None,
          floorOverride = None
        )
      ),
      classifiedAt = ts
    )

  private def nextMarkClassified(): AdServer.MarkClassified =
    adServerProbe.fishForMessage(3.seconds) {
      case _: AdServer.MarkClassified => org.apache.pekko.actor.testkit.typed.FishingOutcome.Complete
      case _                          => org.apache.pekko.actor.testkit.typed.FishingOutcome.ContinueAndIgnore
    }.head.asInstanceOf[AdServer.MarkClassified]

  "RestoreClassifications" should {

    "restore an unseen page, skip the identical resend, restore a newer one" in {
      val topic = testKit.spawn(
        Topic[CampaignEntity.CampaignChanged](s"campaign-changed-${java.util.UUID.randomUUID()}")
      )
      val auctioneer = testKit.spawn(
        AuctioneerEntity(SiteId("site-restore"), sharding, budgetTopic, topic)
      )
      val url = "https://site-restore.example/page"

      // 1. Unseen page restores: freshness token repopulated.
      auctioneer ! AuctioneerEntity.RestoreClassifications(Map(url -> entry(freshMs)))
      val first = nextMarkClassified()
      first.url.value shouldBe url
      first.classifiedAt shouldBe Instant.ofEpochMilli(freshMs)

      // 2. Identical resend (the periodic tick's steady state) restores
      //    nothing; 3. a strictly newer entry restores again. Ordering
      //    proves 2: had the resend restored, its MarkClassified(freshMs)
      //    would arrive BEFORE the newer one on the same actor pair.
      auctioneer ! AuctioneerEntity.RestoreClassifications(Map(url -> entry(freshMs)))
      auctioneer ! AuctioneerEntity.RestoreClassifications(Map(url -> entry(newerMs)))
      val second = nextMarkClassified()
      second.url.value shouldBe url
      second.classifiedAt shouldBe Instant.ofEpochMilli(newerMs)

      // Stop the entity inside the 1s debounce window: the kicked
      // re-auction would otherwise fan out into ranking machinery this
      // harness doesn't stub, leaving asks in flight that stall testkit
      // shutdown. Timers die with the actor; the restores under test
      // have already been asserted.
      testKit.stop(auctioneer)

      // Nothing further reached AdServer (the identical resend restored
      // nothing — its MarkClassified(freshMs) would have preceded `second`).
      adServerProbe.expectNoMessage(300.millis)
    }

    // SiteEntity never prunes its persisted pageClassifications, so its
    // 5-minute resend always carries pages past the freshness window. Once
    // CleanupStaleContent evicts one, `lastPage.get(url)` is None — and
    // None.forall(_) is TRUE — so the entry came straight back with its
    // original stale timestamp, and the two chased each other forever.
    // Live on 2026-08-06: "Restored 11 page classifications" on EVERY tick,
    // PeriodicReauction warning about the same never-shrinking stale set,
    // and a wasted re-auction each time. Restore must apply the same
    // freshness predicate cleanup does.
    "drop entries older than the freshness window so cleanup's eviction sticks" in {
      val topic = testKit.spawn(
        Topic[CampaignEntity.CampaignChanged](s"campaign-changed-${java.util.UUID.randomUUID()}")
      )
      val auctioneer = testKit.spawn(
        AuctioneerEntity(SiteId("site-restore-stale"), sharding, budgetTopic, topic)
      )
      val staleUrl = "https://site-restore-stale.example/old"
      val freshUrl = "https://site-restore-stale.example/current"

      // A resend carrying both: only the fresh one may come through, and the
      // stale one must not reach AdServer even as an unseen URL.
      auctioneer ! AuctioneerEntity.RestoreClassifications(
        Map(staleUrl -> entry(staleMs), freshUrl -> entry(freshMs))
      )
      val restored = nextMarkClassified()
      restored.url.value shouldBe freshUrl
      restored.classifiedAt shouldBe Instant.ofEpochMilli(freshMs)

      // Resending the stale entry alone — the steady state after an eviction
      // — must be a true no-op: nothing restored, nothing marked classified.
      auctioneer ! AuctioneerEntity.RestoreClassifications(Map(staleUrl -> entry(staleMs)))

      testKit.stop(auctioneer)
      adServerProbe.expectNoMessage(500.millis)
    }
  }
}
