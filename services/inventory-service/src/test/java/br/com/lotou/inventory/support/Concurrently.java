package br.com.lotou.inventory.support;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.function.IntFunction;

/** Dispara várias tarefas no mesmo instante, para provocar disputa de verdade. */
public final class Concurrently {

    /** O que uma tarefa devolveu, ou a exceção com que falhou. */
    public record Result<T>(T value, Throwable error) {

        public boolean succeeded() {
            return this.error == null;
        }
    }

    private Concurrently() {
    }

    public static <T> List<Result<T>> run(int tasks, IntFunction<T> task) {
        var start = new CountDownLatch(1);
        try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<Result<T>>> futures = new ArrayList<>();
            for (int i = 0; i < tasks; i++) {
                int index = i;
                Callable<Result<T>> callable = () -> {
                    start.await();
                    try {
                        return new Result<>(task.apply(index), null);
                    }
                    catch (Throwable error) {
                        return new Result<>(null, error);
                    }
                };
                futures.add(executor.submit(callable));
            }
            start.countDown();
            List<Result<T>> results = new ArrayList<>();
            for (Future<Result<T>> future : futures) {
                results.add(future.get());
            }
            return results;
        }
        catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }
}
